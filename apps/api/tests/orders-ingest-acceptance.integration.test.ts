import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { orderLines, orders } from "../src/db/schema.js";
import { ingestOrders, type OrdersExportFetcher } from "../src/modules/orders/ingest.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// Prijímacia brána (malformed/prázdny export, chýbajúci povinný stĺpec,
// trust-on-first-use, drastický pokles oproti databáze) — vydelené z
// `orders-ingest.integration.test.ts` (issue 412), aby ani jeden súbor
// nenarástol cez `.claude/rules/testing.md`'s eslint `max-lines: 400`,
// rovnaký vzor ako `orders-ingest-posta-fields.integration.test.ts`.
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
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-orders-acceptance-raw-"));
  return { db: ctx.db, dir: rawDir };
}

function fetcherOf(body: Buffer): OrdersExportFetcher {
  return () => Promise.resolve({ body, sourceLabel: "fixtúra" });
}

// Rovnaký ASCII-only dôvod ako `orders-ingest.integration.test.ts`'s
// `buildCsv` (`.claude/rules/orders.md`) — `ingestOrders` vždy dekóduje ako
// windows-1250, diakritika priamo tu by na druhej strane vyšla pokazená.
function buildCsv(header: readonly string[], rows: readonly Record<string, string>[]): Buffer {
  const esc = (v: string): string => `"${v.replaceAll('"', '""')}"`;
  const lines = [header.map(esc).join(";") + ";"];
  for (const row of rows) {
    lines.push(header.map((c) => esc(row[c] ?? "")).join(";") + ";");
  }
  return Buffer.from(lines.join("\r\n") + "\r\n", "utf-8");
}

const HEADER = [
  "code",
  "date",
  "statusName",
  "billFullName",
  "deliveryFullName",
  "itemName",
  "itemAmount",
  "itemCode",
  "remark",
  "shopRemark",
] as const;

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
