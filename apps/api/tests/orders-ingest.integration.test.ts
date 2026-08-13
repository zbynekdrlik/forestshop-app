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
  // issue 65: fixtúra nesie order 20300001 so zákazníckym odkazom (`remark`).
  expect(order1[0]?.remark).toBe("Prosím doručiť len v piatok, ďakujem");
  // issue 164: tá istá objednávka nesie AJ internú poznámku e-shopu
  // (`shopRemark`, stĺpec 28) — nezávislé pole od `remark` vyššie.
  expect(order1[0]?.shopRemark).toBe("Zakaznik je stavebna firma, vybavit prednostne");
  const order2 = await db.select().from(orders).where(eq(orders.externalOrderId, "20300002"));
  expect(order2[0]?.customerName).toBe("Eva Malá"); // fallback na deliveryFullName
  expect(order2[0]?.statusName).toBe("Vybavená");
  // issue 65: order 20300002 nemá vo fixtúre vyplnený `remark` → `null`.
  expect(order2[0]?.remark).toBeNull();
  // issue 164: rovnako `shopRemark` — fixtúra ho pre túto objednávku nenesie.
  expect(order2[0]?.shopRemark).toBeNull();
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

// issue 65: `remark` (zákaznícky odkaz) je rovnaká rodina ako `status_name`
// vyššie — VŽDY Shoptetovo pole (na rozdiel od `comment`), re-import ho MUSÍ
// osviežiť.
it("remark je Shoptetovo pole a re-import ho osvieži, keď sa v Shoptete zmení", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  const bezOdkazu = buildCsv(HEADER, [
    { code: "9102", date: "2026-07-01 10:00:00", statusName: "Vybavuje sa", billFullName: "X", itemName: "Y", itemAmount: "1", itemCode: "40237/XL" },
  ]);
  await ingestOrders(db, { fetchExport: fetcherOf(bezOdkazu), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const [prvyRead] = await db.select().from(orders).where(eq(orders.externalOrderId, "9102"));
  expect(prvyRead?.remark).toBeNull();

  // ASCII-only text (rovnaký dôvod ako inde v tomto súbore — `buildCsv`
  // produkuje UTF-8, ale `ingestOrders` VŽDY dekóduje ako windows-1250,
  // takže diakritika by na druhej strane vyšla ako mojibake).
  const sOdkazom = buildCsv(HEADER, [
    {
      code: "9102",
      date: "2026-07-01 10:00:00",
      statusName: "Vybavuje sa",
      billFullName: "X",
      itemName: "Y",
      itemAmount: "1",
      itemCode: "40237/XL",
      remark: "Zavolajte pred dorucenim",
    },
  ]);
  await ingestOrders(db, { fetchExport: fetcherOf(sOdkazom), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const [druhyRead] = await db.select().from(orders).where(eq(orders.externalOrderId, "9102"));
  expect(druhyRead?.remark).toBe("Zavolajte pred dorucenim");
});

// issue 164: `shopRemark` (interná poznámka e-shopu) je TIEŽ VŽDY Shoptetovo
// pole (rovnaká rodina ako `remark`/`status_name` vyššie) — re-import ho
// MUSÍ osviežiť. Uložená hodnota je SUROVÁ (bez straty/mutácie) — appka pri
// IMPORTE nič nezapisuje späť, takže cudzí text v tomto poli sa nikdy
// neprepíše (appka ho len ČÍTA).
it("shopRemark je Shoptetovo pole, re-import ho osvieži a uloží SUROVO (bez straty dát)", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  const bezPoznamky = buildCsv(HEADER, [
    { code: "9103", date: "2026-07-01 10:00:00", statusName: "Vybavuje sa", billFullName: "X", itemName: "Y", itemAmount: "1", itemCode: "40237/XL" },
  ]);
  await ingestOrders(db, { fetchExport: fetcherOf(bezPoznamky), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const [prvyRead] = await db.select().from(orders).where(eq(orders.externalOrderId, "9103"));
  expect(prvyRead?.shopRemark).toBeNull();

  // Text obsahuje ASCII náprotivok nášho oddeľovacieho bloku (`note-block.ts`)
  // PLUS cudzí text okolo — dokazuje, že import ukladá SUROVÚ hodnotu
  // BEZ straty ani jedného znaku, nikdy nič neodstraňuje/nezlučuje.
  const sPoznamkou = buildCsv(HEADER, [
    {
      code: "9103",
      date: "2026-07-01 10:00:00",
      statusName: "Vybavuje sa",
      billFullName: "X",
      itemName: "Y",
      itemAmount: "1",
      itemCode: "40237/XL",
      shopRemark: "Rucna poznamka predajne --- poznamka z appky --- x --- koniec ---",
    },
  ]);
  await ingestOrders(db, { fetchExport: fetcherOf(sPoznamkou), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const [druhyRead] = await db.select().from(orders).where(eq(orders.externalOrderId, "9103"));
  expect(druhyRead?.shopRemark).toBe("Rucna poznamka predajne --- poznamka z appky --- x --- koniec ---");

  // Ďalší re-import s inou hodnotou musí OSVIEŽIŤ (nikdy nezachovať starú) —
  // rovnaký dôvod ako `remark`/`status_name`.
  const inaPoznamka = buildCsv(HEADER, [
    {
      code: "9103",
      date: "2026-07-01 10:00:00",
      statusName: "Vybavuje sa",
      billFullName: "X",
      itemName: "Y",
      itemAmount: "1",
      itemCode: "40237/XL",
      shopRemark: "Zmenene v Shoptete priamo",
    },
  ]);
  await ingestOrders(db, { fetchExport: fetcherOf(inaPoznamka), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const [tretiRead] = await db.select().from(orders).where(eq(orders.externalOrderId, "9103"));
  expect(tretiRead?.shopRemark).toBe("Zmenene v Shoptete priamo");
});

// issue 237: `totalPriceWithVat` re-import refresh test presunutý do
// `orders-ingest-total-price.integration.test.ts` — pridanie priamo sem by
// poslalo tento súbor cez eslint `max-lines: 400` (rovnaký dôvod/vzor ako
// `orders-ingest-posta-fields.integration.test.ts`'s split).

// issue 120: `fetchOrderIds` je BEST-EFFORT obohatenie o interné Shoptet id
// (XML export) — samostatná fáza od hlavného CSV importu vyššie.
it("uloží interné Shoptet id z fetchOrderIds vedľa CSV importu", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  const csv = buildCsv(HEADER, [
    { code: "9103", date: "2026-07-01 10:00:00", statusName: "Vybavuje sa", billFullName: "X", itemName: "Y", itemAmount: "1", itemCode: "40237/XL" },
  ]);
  await ingestOrders(db, {
    fetchExport: fetcherOf(csv),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    fetchOrderIds: () => Promise.resolve(new Map([["9103", 58728]])),
  });

  const [rows] = await db.select().from(orders).where(eq(orders.externalOrderId, "9103"));
  expect(rows?.shoptetOrderId).toBe(58728);
});

// issue 132: `fetchOrderIds` môže byť (cez `computeOrderIdsWindowStart`,
// `backfill.ts`) NAMERANÉ na ŠIRŠIE okno než hlavný CSV import — pozná teda
// aj objednávky, ktoré CSV export tohto behu vôbec NENESIE (staršie než
// jeho vlastné, nerozšírené okno). Bez samostatného backfill kroku by ich
// `shoptetOrderId` NIKDY nedostal zápis, lebo hlavný upsert cyklus prechádza
// LEN `orderInfo` (postavené z CSV) — `orderIdsByCode.get(externalOrderId)`
// sa vôbec nezavolá pre id, ktorého kľúč v `orderInfo` chýba.
it("fetchOrderIds pozná objednávku, ktorá NIE JE v tomto behu CSV (staršia než jeho okno) — id sa napriek tomu zapíše", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  // Objednávka 9106 UŽ existuje v DB (predchádzajúci import), otvorená,
  // bez interného id — presne stav 20260739 pred touto opravou.
  await db.insert(orders).values({
    externalOrderId: "9106",
    customerName: "Starý zákazník",
    statusName: "Vybavuje sa",
    placedAt: new Date("2026-01-01T00:00:00Z"),
    shoptetOrderId: null,
  });

  // Tento beh CSV nesie LEN inú, novšiu objednávku (9107) — 9106 v ňom
  // vôbec nie je, presne ako keď je staršia než CSV okno.
  const csv = buildCsv(HEADER, [
    { code: "9107", date: "2026-07-01 10:00:00", statusName: "Vybavuje sa", billFullName: "X", itemName: "Y", itemAmount: "1", itemCode: "40237/XL" },
  ]);
  const result = await ingestOrders(db, {
    fetchExport: fetcherOf(csv),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    // Rozšírená XML mapa (ako by ju vrátil computeOrderIdsWindowStart-om
    // rozšírený fetch) — pozná AJ 9106, hoci CSV vyššie ju nenesie.
    fetchOrderIds: () => Promise.resolve(new Map([["9107", 58729], ["9106", 58184]])),
  });

  expect(result.status).toBe("accepted");
  const [stara] = await db.select().from(orders).where(eq(orders.externalOrderId, "9106"));
  expect(stara?.shoptetOrderId).toBe(58184);
  const [nova] = await db.select().from(orders).where(eq(orders.externalOrderId, "9107"));
  expect(nova?.shoptetOrderId).toBe(58729);
});

it("zlyhaný fetchOrderIds NEODMIETNE import CSV — objednávka sa uloží bez id", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  const csv = buildCsv(HEADER, [
    { code: "9104", date: "2026-07-01 10:00:00", statusName: "Vybavuje sa", billFullName: "X", itemName: "Y", itemAmount: "1", itemCode: "40237/XL" },
  ]);
  const result = await ingestOrders(db, {
    fetchExport: fetcherOf(csv),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    fetchOrderIds: () => Promise.reject(new Error("XML export nedostupný")),
  });

  expect(result.status).toBe("accepted");
  const [rows] = await db.select().from(orders).where(eq(orders.externalOrderId, "9104"));
  expect(rows?.shoptetOrderId).toBeNull();
});

// issue 120: re-import BEZ `fetchOrderIds` (napr. XML premenná dočasne
// nenastavená) NESMIE vynulovať predtým zistené id — COALESCE v `ingest.ts`
// chráni starú hodnotu.
it("re-import bez fetchOrderIds nevynuluje predtým zistené interné Shoptet id", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  const csv = buildCsv(HEADER, [
    { code: "9105", date: "2026-07-01 10:00:00", statusName: "Vybavuje sa", billFullName: "X", itemName: "Y", itemAmount: "1", itemCode: "40237/XL" },
  ]);
  await ingestOrders(db, {
    fetchExport: fetcherOf(csv),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    fetchOrderIds: () => Promise.resolve(new Map([["9105", 58728]])),
  });

  // Re-import BEZ fetchOrderIds vôbec — rovnaká situácia ako appka bez
  // nastavenej SHOPTET_ORDERS_XML_URL.
  await ingestOrders(db, { fetchExport: fetcherOf(csv), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });

  const [rows] = await db.select().from(orders).where(eq(orders.externalOrderId, "9105"));
  expect(rows?.shoptetOrderId).toBe(58728);
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
  // issue 65: `remark` sa AJ TAK osviežuje (je to Shoptetovo pole) — tu
  // ostáva len nezmenené, lebo fixtúra sa re-importuje bez zmeny; skutočnú
  // zmenu dokazuje samostatný test vyššie ("remark je Shoptetovo pole…").
  expect(reread?.remark).toBe("Prosím doručiť len v piatok, ďakujem");
  // issue 164: presne TOTO je akceptačná podmienka "kruh sa uzavrie" —
  // manažérov `comment` prežije re-import NEDOTKNUTÝ (overené vyššie), zatiaľ
  // čo `shop_remark` (Shoptetovo pole) sa AJ TAK znovu prečíta z exportu.
  // Keby appka niekedy writebackla `comment` do Shoptetu a fixtúra by pri
  // ĎALŠOM importe niesla náš vlastný blok, presne tento stĺpec by ho
  // priniesol späť — bez toho, aby sa čo i len raz dotkol `comment` samotného.
  expect(reread?.shopRemark).toBe("Zakaznik je stavebna firma, vybavit prednostne");
  const [rereadLine] = await db.select().from(orderLines).where(eq(orderLines.orderId, order1.id));
  expect(rereadLine?.state).toBe("skladom");
  expect(rereadLine?.quantity).toBe(3); // množstvo sa AJ TAK osviežuje
});

// issue 412: majiteľ nahlásil, že objednávka 20261306 zmenená v Shoptete na
// úplne iný produkt stále ukazuje STARÝ, dávno vymenený produkt — import
// dovtedy len INSERToval/UPDATEoval, nikdy nemazal riadok, ktorého
// (objednávka, variant) dvojica z novšieho exportu zmizla. Scenár nižšie
// pokrýva OBE tvrdenia zadania naraz: (1) vymenený produkt sa NAHRADÍ (stará
// položka zmizne, nová sa objaví s predvolenými hodnotami — nezačala sa ešte
// vybavovať), (2) SÚRODENECKÝ riadok tej istej objednávky, ktorého produkt sa
// NEZMENIL, si ZACHOVÁ manažérom nastavený stav — dôkaz, že reconciliation je
// CIELENÝ (mazacia množina = presne to, čo z exportu zmizlo), nie plný
// replace celej objednávky (ktorý by reštartoval aj nezmenené riadky).
it("re-import ODSTRÁNI riadok produktu, ktorý Shoptet z objednávky vymenil, a zachová stav nezmeneného súrodeneckého riadku", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL"); // "A" — bude vymenený
  await insertTestVariant(db, "40238/M"); // "B" — nahradí A
  await insertTestVariant(db, "40239/S"); // "C" — ostáva nezmenený súrodenec

  const povodna = buildCsv(HEADER, [
    { code: "9201", date: "2026-07-01 10:00:00", statusName: "Vybavuje sa", billFullName: "Pavol Bajčičák", itemName: "Produkt A", itemAmount: "1", itemCode: "40237/XL" },
    { code: "9201", date: "2026-07-01 10:00:00", statusName: "Vybavuje sa", billFullName: "Pavol Bajčičák", itemName: "Produkt C", itemAmount: "1", itemCode: "40239/S" },
  ]);
  await ingestOrders(db, { fetchExport: fetcherOf(povodna), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });

  const [order9201] = await db.select().from(orders).where(eq(orders.externalOrderId, "9201"));
  if (order9201 === undefined) throw new Error("objednávka sa nenašla");
  const povodneRiadky = await db.select().from(orderLines).where(eq(orderLines.orderId, order9201.id));
  expect(povodneRiadky).toHaveLength(2);
  const [lineA] = povodneRiadky.filter((l) => l.variantCode === "40237/XL");
  const [lineC] = povodneRiadky.filter((l) => l.variantCode === "40239/S");
  if (lineA === undefined || lineC === undefined) throw new Error("riadok sa nenašiel");
  // Manažér oba riadky ručne spracoval PRED tým, než Shoptet vymenil produkt A.
  await db.update(orderLines).set({ state: "nedostupne", ordered: false }).where(eq(orderLines.id, lineA.id));
  await db.update(orderLines).set({ state: "caka_sa", ordered: true }).where(eq(orderLines.id, lineC.id));

  // Shoptet: produkt A vymenený za B, C ostáva nezmenený (rovnaké množstvo).
  const zmenena = buildCsv(HEADER, [
    { code: "9201", date: "2026-07-01 10:00:00", statusName: "Vybavuje sa", billFullName: "Pavol Bajčičák", itemName: "Produkt B", itemAmount: "1", itemCode: "40238/M" },
    { code: "9201", date: "2026-07-01 10:00:00", statusName: "Vybavuje sa", billFullName: "Pavol Bajčičák", itemName: "Produkt C", itemAmount: "1", itemCode: "40239/S" },
  ]);
  const result = await ingestOrders(db, { fetchExport: fetcherOf(zmenena), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  expect(result.status).toBe("accepted");

  const noveRiadky = await db.select().from(orderLines).where(eq(orderLines.orderId, order9201.id));
  // Presne 2 riadky — STARÝ "A" je preč, "B" pribudol, "C" ostal (nie 3).
  expect(noveRiadky).toHaveLength(2);
  const zostavaA = noveRiadky.find((l) => l.variantCode === "40237/XL");
  expect(zostavaA).toBeUndefined(); // obrazovka "Na objednanie" už NESMIE ukázať vymenený produkt A

  const novyB = noveRiadky.find((l) => l.variantCode === "40238/M");
  expect(novyB).toBeDefined(); // obrazovka MUSÍ ukázať nový produkt B
  expect(novyB?.state).toBe("objednane"); // nový riadok, predvolený stav — vybavovanie začína odznova
  expect(novyB?.ordered).toBe(false);

  const zachovanyC = noveRiadky.find((l) => l.variantCode === "40239/S");
  expect(zachovanyC).toBeDefined();
  // C sa v exporte nezmenil — jeho manažérom nastavený stav MUSÍ prežiť,
  // presne ako existujúci test vyššie dokazuje pre celú nezmenenú objednávku.
  expect(zachovanyC?.state).toBe("caka_sa");
  expect(zachovanyC?.ordered).toBe(true);
});

// issue 412: prijímacia brána (prázdny export, chýbajúci povinný stĺpec,
// poškodený riadok, trust-on-first-use, drastický pokles) presunutá do
// `orders-ingest-acceptance.integration.test.ts` — pridanie nového
// reconciliation testu priamo sem by poslalo tento súbor cez eslint
// `max-lines: 400` (rovnaký dôvod/vzor ako `orders-ingest-posta-fields
// .integration.test.ts`'s split vyššie).
