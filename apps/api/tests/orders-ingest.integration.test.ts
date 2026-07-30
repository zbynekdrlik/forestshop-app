import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { orderLines, orders } from "../src/db/schema.js";
import { ingestOrders, type OrdersExportFetcher } from "../src/modules/orders/ingest.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

const FIXTURE = readFileSync(fileURLToPath(new URL("../src/modules/orders/fixtures/orders-sample.csv", import.meta.url)));

// Fixtúra pokrýva 2026-01-15 (order 20300003) až 2026-06-16 (order 20300002) —
// okno je zámerne veľkorysé, aby zahŕňalo obe bez ohľadu na časovú zónu
// posun v `parseShopLocalDateTime`.
const WINDOW_START = new Date("2020-01-01T00:00:00Z");
const WINDOW_END = new Date("2030-01-01T00:00:00Z");
const NOW = new Date("2026-07-30T10:00:00Z");

let close: (() => Promise<void>) | undefined;
let rawDir: string | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  if (rawDir !== undefined) await rm(rawDir, { recursive: true, force: true });
  rawDir = undefined;
});

async function boot(): Promise<{ db: Awaited<ReturnType<typeof withCleanDb>>["db"]; dir: string }> {
  const ctx = await withCleanDb();
  close = ctx.close;
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-orders-raw-"));
  return { db: ctx.db, dir: rawDir };
}

function fetcherOf(body: Buffer): OrdersExportFetcher {
  return () => Promise.resolve({ body, sourceLabel: "fixtúra" });
}

// POZOR (issue 59): vrátený Buffer je UTF-8, ale `ingestOrders` VŽDY dekóduje
// vstup ako windows-1250 (`decodeCp1250`, rovnaký zámer ako skutočný
// Shoptet export) — akýkoľvek non-ASCII znak (diakritika) v `rows` tu preto
// vyjde na druhej strane pokazený (mojibake), lebo dva rôzne bajty UTF-8
// znaku sa dekódujú AKO DVA samostatné cp1250 znaky. Testy nad touto
// funkciou preto musia byť ASCII-only (rovnaký dôvod, prečo existujúce
// testy nikdy nepoužili diakritiku priamo tu) — skutočná diakritika sa
// testuje cez commitnutú fixtúru (`fixtures/orders-sample.csv`), ktorá JE
// natívne cp1250 na disku.
function buildCsv(header: readonly string[], rows: readonly Record<string, string>[]): Buffer {
  const esc = (v: string): string => `"${v.replaceAll('"', '""')}"`;
  const lines = [header.map(esc).join(";") + ";"];
  for (const row of rows) {
    lines.push(header.map((c) => esc(row[c] ?? "")).join(";") + ";");
  }
  return Buffer.from(lines.join("\r\n") + "\r\n", "utf-8");
}

const HEADER = ["code", "date", "statusName", "billFullName", "deliveryFullName", "itemName", "itemAmount", "itemCode"] as const;

it("prijme fixtúru: reálne položky zapíše, duplicitný riadok sčíta, pseudo-položky aj neznámy variant preskočí", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");
  await insertTestVariant(db, "40238/M");
  await insertTestVariant(db, "40239/S");
  // "99999/ZZ" (fixtúra, order 20300002) sa ZÁMERNE nevkladá — má simulovať
  // položku, ktorú Shoptet vráti, ale náš katalóg ju nepozná.

  const result = await ingestOrders(db, {
    fetchExport: fetcherOf(FIXTURE),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });

  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error("unreachable");
  expect(result.orderCount).toBe(3);
  // 40237/XL (2+1 sčítané), 40238/M, 40239/S = 3 riadky; SHIPPING6, 99999/ZZ,
  // prázdny itemCode NEPATRIA do lineCount.
  expect(result.lineCount).toBe(3);
  expect(result.skippedItemCount).toBe(1); // 99999/ZZ
  expect(result.pseudoItemCount).toBe(1); // SHIPPING6

  const summed = await db.select().from(orderLines).innerJoin(orders, eq(orderLines.orderId, orders.id)).where(
    eq(orders.externalOrderId, "20300001"),
  );
  expect(summed).toHaveLength(1);
  expect(summed[0]?.order_line.quantity).toBe(3); // 2 + 1 sčítané

  const order1 = await db.select().from(orders).where(eq(orders.externalOrderId, "20300001"));
  expect(order1[0]?.customerName).toBe("Ján Novák");
  // issue 59: fixtúra nesie order 20300001 v stave "Vybavuje sa" (otvorená),
  // 20300002 v stave "Vybavená" (uzavretá) — presne to appka teraz ukladá.
  expect(order1[0]?.statusName).toBe("Vybavuje sa");
  const order2 = await db.select().from(orders).where(eq(orders.externalOrderId, "20300002"));
  expect(order2[0]?.customerName).toBe("Eva Malá"); // fallback na deliveryFullName
  expect(order2[0]?.statusName).toBe("Vybavená");
});

// issue 59: `status_name` je VŽDY Shoptetovo pole (na rozdiel od `comment`/
// `order_line.state` v teste vyššie) — re-import ho MUSÍ osviežiť, inak by
// objednávka prejdená v Shoptete z "Vybavuje sa" na "Vybavená" navždy
// zostala v appke ako otvorená.
it("objednávka nesie stav zo Shoptetu a re-import ho osvieži, keď sa v Shoptete zmení", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  const otvorena = buildCsv(HEADER, [
    { code: "9101", date: "2026-07-01 10:00:00", statusName: "Vybavuje sa", billFullName: "X", itemName: "Y", itemAmount: "1", itemCode: "40237/XL" },
  ]);
  await ingestOrders(db, { fetchExport: fetcherOf(otvorena), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const [prvyRead] = await db.select().from(orders).where(eq(orders.externalOrderId, "9101"));
  expect(prvyRead?.statusName).toBe("Vybavuje sa");

  const uzavreta = buildCsv(HEADER, [
    { code: "9101", date: "2026-07-01 10:00:00", statusName: "Vybavena", billFullName: "X", itemName: "Y", itemAmount: "1", itemCode: "40237/XL" },
  ]);
  await ingestOrders(db, { fetchExport: fetcherOf(uzavreta), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const [druhyRead] = await db.select().from(orders).where(eq(orders.externalOrderId, "9101"));
  expect(druhyRead?.statusName).toBe("Vybavena");
});

it("re-import tej istej fixtúry je idempotentný — žiadne duplicitné riadky, množstvo ostáva rovnaké", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");
  await insertTestVariant(db, "40238/M");
  await insertTestVariant(db, "40239/S");

  await ingestOrders(db, { fetchExport: fetcherOf(FIXTURE), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const second = await ingestOrders(db, {
    fetchExport: fetcherOf(FIXTURE),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });

  expect(second.status).toBe("accepted");
  const allLines = await db.select().from(orderLines);
  expect(allLines).toHaveLength(3); // nie 6 — druhý import upsertol, nevložil duplicitne
  const allOrders = await db.select().from(orders);
  expect(allOrders).toHaveLength(3);
});

it("re-import NIKDY neprepíše ručne nastavený stav riadku ani komentár objednávky", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");
  await insertTestVariant(db, "40238/M");
  await insertTestVariant(db, "40239/S");
  await ingestOrders(db, { fetchExport: fetcherOf(FIXTURE), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });

  const [order1] = await db.select().from(orders).where(eq(orders.externalOrderId, "20300001"));
  if (order1 === undefined) throw new Error("objednávka sa nenašla");
  await db.update(orders).set({ comment: "Zavolať zákazníkovi" }).where(eq(orders.id, order1.id));
  const [line1] = await db.select().from(orderLines).where(eq(orderLines.orderId, order1.id));
  if (line1 === undefined) throw new Error("riadok sa nenašiel");
  await db.update(orderLines).set({ state: "skladom" }).where(eq(orderLines.id, line1.id));

  await ingestOrders(db, { fetchExport: fetcherOf(FIXTURE), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });

  const [reread] = await db.select().from(orders).where(eq(orders.externalOrderId, "20300001"));
  expect(reread?.comment).toBe("Zavolať zákazníkovi");
  const [rereadLine] = await db.select().from(orderLines).where(eq(orderLines.orderId, order1.id));
  expect(rereadLine?.state).toBe("skladom");
  expect(rereadLine?.quantity).toBe(3); // množstvo sa AJ TAK osviežuje
});

it("prázdny (0 bajtov) export sa odmietne bez zápisu", async () => {
  const { db, dir } = await boot();
  const result = await ingestOrders(db, {
    fetchExport: fetcherOf(Buffer.alloc(0)),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });
  expect(result.status).toBe("rejected");
  expect(await db.select().from(orders)).toHaveLength(0);
});

it("export bez povinného stĺpca (napr. 'date') sa odmietne", async () => {
  const { db, dir } = await boot();
  const header = HEADER.filter((c) => c !== "date");
  const csv = buildCsv(header, [
    { code: "1", billFullName: "X", itemName: "Y", itemAmount: "1", itemCode: "40237/XL" },
  ]);
  const result = await ingestOrders(db, {
    fetchExport: fetcherOf(csv),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") expect(result.reason).toContain("date");
});

it("poškodený riadok (počet polí nesedí s hlavičkou) sa odmietne ako celok", async () => {
  const { db, dir } = await boot();
  const good = HEADER.map((c) => `"${c === "code" ? "1" : c === "date" ? "2026-01-01 00:00:00" : c === "itemAmount" ? "1" : c === "itemCode" ? "40237/XL" : "x"}"`).join(";") + ";";
  const malformed = `"1";"2026-01-01 00:00:00";"x"` + ";"; // menej polí než hlavička
  const csv = Buffer.from([HEADER.map((c) => `"${c}"`).join(";") + ";", good, malformed].join("\r\n") + "\r\n", "utf-8");

  const result = await ingestOrders(db, {
    fetchExport: fetcherOf(csv),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") expect(result.reason).toContain("poškodený riadok");
});

it("prvý import okna s NULA použiteľnými riadkami sa PRIJME (trust-on-first-use)", async () => {
  const { db, dir } = await boot();
  const csv = buildCsv(HEADER, [
    { code: "1", billFullName: "X", itemName: "Doprava", itemAmount: "1", itemCode: "SHIPPING6" },
  ]);
  const result = await ingestOrders(db, {
    fetchExport: fetcherOf(csv),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });
  expect(result.status).toBe("accepted");
});

it("drastický pokles oproti tomu, čo je už v databáze pre TO ISTÉ okno, sa odmietne bez zápisu", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40999/X");
  for (let i = 0; i < 20; i += 1) {
    const [order] = await db
      .insert(orders)
      .values({ externalOrderId: `BASE-${String(i)}`, customerName: "Test", placedAt: new Date("2026-05-01T00:00:00Z") })
      .returning();
    if (order === undefined) throw new Error("insert zlyhal");
    await db.insert(orderLines).values({ orderId: order.id, variantCode: "40999/X", quantity: 1 });
  }

  // Podlaha = floor(20 * 0.2) = 4; táto fixtúra dá len 1 použiteľný riadok.
  const csv = buildCsv(HEADER, [
    { code: "NEW-1", date: "2026-05-02 10:00:00", billFullName: "Y", itemName: "Z", itemAmount: "1", itemCode: "40999/X" },
  ]);
  const result = await ingestOrders(db, {
    fetchExport: fetcherOf(csv),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") expect(result.reason).toContain("20");
  expect(await db.select().from(orders)).toHaveLength(20); // žiadny nový riadok nepribudol
});
