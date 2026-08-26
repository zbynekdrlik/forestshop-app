import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { orders } from "../src/db/schema.js";
import { DEFAULT_ORDER_OPEN_STATUS, listOpenStatusNames } from "../src/modules/orders/open-statuses.js";
import {
  computeOrdersExportWindowStart,
  computeOrdersIngestWindows,
  findOldestOpenOrder,
} from "../src/modules/orders/backfill.js";
import { computeImportWindow } from "../src/modules/orders/fetcher.js";
import {
  DEFAULT_ORDERS_IMPORT_WINDOW_DAYS,
  ingestOrders,
  type OrdersExportFetcher,
} from "../src/modules/orders/ingest.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 492: objednávka vybavená v Shoptete AŽ PO vypadnutí z 90-dňového
// kĺzavého okna sa už nikdy neosviežila — `order.status_name` (jediná cesta
// osviežovania je CSV import, #59) zamrzol na "Vybavuje sa" a riadok navždy
// visel v "Na objednanie" (20260739). Tieto testy overujú novú `backfill.ts`
// logiku, ktorá okno CSV importu sebaozdravujúco predĺži dozadu, kým existuje
// OTVORENÁ objednávka staršia než predvolené okno — vzor issue 132
// (`computeOrderIdsWindowStart`), ale bez id-filtra: záleží na KAŽDEJ otvorenej
// objednávke, aj tej, čo svoje `shoptet_order_id` už MÁ (presne prípad 20260739).

let close: (() => Promise<void>) | undefined;
let rawDir: string | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  if (rawDir !== undefined) await rm(rawDir, { recursive: true, force: true });
  rawDir = undefined;
});

const DEFAULT_DATE_FROM = new Date("2026-05-03T00:00:00Z");

// --- unit: findOldestOpenOrder / computeOrdersExportWindowStart ---

it("findOldestOpenOrder vráti null, keď žiadna otvorená objednávka neexistuje", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(orders).values({
    externalOrderId: "9201",
    customerName: "Zákazník A",
    statusName: "Vybavená", // uzavretá — mimo open-statuses
    placedAt: new Date("2026-01-01T00:00:00Z"),
    shoptetOrderId: 111,
  });

  expect(await findOldestOpenOrder(ctx.db)).toBeNull();
});

it("findOldestOpenOrder NÁJDE najstaršiu otvorenú objednávku aj keď MÁ shoptet_order_id (na rozdiel od #132)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(orders).values([
    {
      externalOrderId: "20260739",
      customerName: "Andrej Praskač",
      statusName: DEFAULT_ORDER_OPEN_STATUS,
      placedAt: new Date("2026-04-30T10:00:00Z"),
      shoptetOrderId: 58184, // MÁ id — #132's findOldestOpenOrderMissingShoptetId by ho preskočil
    },
    {
      externalOrderId: "20260819",
      customerName: "Martina Šandor",
      statusName: DEFAULT_ORDER_OPEN_STATUS,
      placedAt: new Date("2026-05-14T10:00:00Z"),
      shoptetOrderId: 58422,
    },
  ]);

  const oldest = await findOldestOpenOrder(ctx.db);
  expect(oldest?.toISOString()).toBe(new Date("2026-04-30T10:00:00Z").toISOString());
});

it("computeOrdersExportWindowStart NEZUŽUJE predvolené okno, keď žiadna otvorená objednávka nie je staršia", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(orders).values({
    externalOrderId: "9202",
    customerName: "Zákazník B",
    statusName: DEFAULT_ORDER_OPEN_STATUS,
    placedAt: new Date("2026-06-01T10:00:00Z"), // vnútri okna
    shoptetOrderId: 222,
  });

  expect(await computeOrdersExportWindowStart(ctx.db, DEFAULT_DATE_FROM)).toEqual(DEFAULT_DATE_FROM);
});

it("computeOrdersExportWindowStart PREDĹŽI okno dozadu na staršiu otvorenú objednávku (aj s id)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const stara = new Date("2026-04-30T10:00:00Z"); // staršia než DEFAULT_DATE_FROM
  await ctx.db.insert(orders).values({
    externalOrderId: "20260739",
    customerName: "Andrej Praskač",
    statusName: DEFAULT_ORDER_OPEN_STATUS,
    placedAt: stara,
    shoptetOrderId: 58184,
  });

  const windowStart = await computeOrdersExportWindowStart(ctx.db, DEFAULT_DATE_FROM);
  expect(windowStart.toISOString()).toBe(stara.toISOString());
});

it("computeOrdersExportWindowStart NEROZŠÍRI, keď je uzavretá stará objednávka (mimo open-statuses)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(orders).values({
    externalOrderId: "9203",
    customerName: "Zákazník C",
    statusName: "Vybavená", // stará ALE uzavretá — nemá sa čo dočítavať
    placedAt: new Date("2026-01-01T00:00:00Z"),
    shoptetOrderId: 333,
  });

  expect(await computeOrdersExportWindowStart(ctx.db, DEFAULT_DATE_FROM)).toEqual(DEFAULT_DATE_FROM);
});

// --- unit: computeOrdersIngestWindows (zdieľaný zdroj pravdy drôtovania CLI+scheduler) ---

const NOW_WINDOWS = new Date("2026-08-26T10:00:00Z");

it("computeOrdersIngestWindows: bez otvorených objednávok → obe okná = predvolené 90-dňové", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const { dateFrom, dateUntil } = computeImportWindow(NOW_WINDOWS);

  const w = await computeOrdersIngestWindows(ctx.db, NOW_WINDOWS, { hasXmlUrl: true });
  expect(w.exportDateFrom).toEqual(dateFrom);
  expect(w.idsDateFrom).toEqual(dateFrom);
  expect(w.dateUntil).toEqual(dateUntil);
});

it("computeOrdersIngestWindows: stará otvorená objednávka (s id) rozšíri exportDateFrom; idsDateFrom ostane predvolené (bez XML)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const stara = new Date("2026-04-30T10:00:00Z"); // > 90 dní pred NOW_WINDOWS
  await ctx.db.insert(orders).values({
    externalOrderId: "20260739",
    customerName: "Andrej Praskač",
    statusName: DEFAULT_ORDER_OPEN_STATUS,
    placedAt: stara,
    shoptetOrderId: 58184, // MÁ id → #132 XML okno by ho nechalo tak
  });
  const { dateFrom } = computeImportWindow(NOW_WINDOWS);

  const w = await computeOrdersIngestWindows(ctx.db, NOW_WINDOWS, { hasXmlUrl: false });
  expect(w.exportDateFrom.toISOString()).toBe(stara.toISOString()); // CSV okno rozšírené (#492)
  expect(w.idsDateFrom).toEqual(dateFrom); // bez XML URL → predvolené
});

it("computeOrdersIngestWindows: stará otvorená BEZ id + XML → OBE okná rozšírené", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const stara = new Date("2026-04-30T10:00:00Z");
  await ctx.db.insert(orders).values({
    externalOrderId: "20260740",
    customerName: "Zákazník X",
    statusName: DEFAULT_ORDER_OPEN_STATUS,
    placedAt: stara,
    shoptetOrderId: null, // chýba id → #132 okno ju TIEŽ zachytí
  });

  const w = await computeOrdersIngestWindows(ctx.db, NOW_WINDOWS, { hasXmlUrl: true });
  expect(w.exportDateFrom.toISOString()).toBe(stara.toISOString());
  expect(w.idsDateFrom.toISOString()).toBe(stara.toISOString());
});

// --- end-to-end: stale-status cesta cez ingestOrders + okno-vedomý fetcher ---

const HEADER = ["code", "date", "statusName", "billFullName", "itemName", "itemAmount", "itemCode"] as const;

function buildCsv(rows: readonly Record<string, string>[]): Buffer {
  const esc = (v: string): string => `"${v.replaceAll('"', '""')}"`;
  const lines = [HEADER.map(esc).join(";") + ";"];
  for (const row of rows) lines.push(HEADER.map((c) => esc(row[c] ?? "")).join(";") + ";");
  return Buffer.from(lines.join("\r\n") + "\r\n", "utf-8");
}

// Simuluje Shoptet-ov `dateFrom` filter: STARÁ objednávka (30.4, teraz už
// "Vybavená") je v exporte LEN keď stiahnuté okno siaha po ňu; ČERSTVÁ
// objednávka je v exporte vždy (drží akceptačnú bránu zdravú). `WINDOW_THRESHOLD`
// je bod MEDZI dátumom starej objednávky (30.4) a začiatkom predvoleného
// 90-dňového okna (~28.5 pri NOW=26.8) — NIE presný placed_at (ten je po
// TZ prevode 30.4 13:45 UTC, nie 10:00), takže prah drží obe strany jasne
// oddelené bez ohľadu na presný čas.
const WINDOW_THRESHOLD = new Date("2026-05-10T00:00:00Z");
function windowAwareFetcher(dateFrom: Date): OrdersExportFetcher {
  const rows: Record<string, string>[] = [
    { code: "9210", date: "2026-08-20 09:00:00", statusName: "Vybavuje sa", billFullName: "Cerstva", itemName: "T", itemAmount: "1", itemCode: "40237/XL" },
  ];
  if (dateFrom.getTime() <= WINDOW_THRESHOLD.getTime()) {
    rows.push({ code: "20260739", date: "2026-04-30 15:45:25", statusName: "Vybavena", billFullName: "Andrej", itemName: "T", itemAmount: "1", itemCode: "40237/XL" });
  }
  return () => Promise.resolve({ body: buildCsv(rows), sourceLabel: "fixtúra" });
}

async function boot(): Promise<{ db: Awaited<ReturnType<typeof withCleanDb>>["db"]; dir: string }> {
  const ctx = await withCleanDb();
  close = ctx.close;
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-orders-status-"));
  return { db: ctx.db, dir: rawDir };
}

const NOW = new Date("2026-08-26T10:00:00Z");
const WIDE_START = new Date("2020-01-01T00:00:00Z");
const WIDE_END = new Date("2030-01-01T00:00:00Z");

// Založí starú OTVORENÚ objednávku (30.4, "Vybavuje sa") + čerstvú, tak ako by
// ich appka mala z čias, keď boli obe ešte v okne.
async function seedFrozenOldOrder(db: Awaited<ReturnType<typeof withCleanDb>>["db"], dir: string): Promise<void> {
  await insertTestVariant(db, "40237/XL");
  const seed = buildCsv([
    { code: "9210", date: "2026-08-20 09:00:00", statusName: "Vybavuje sa", billFullName: "Cerstva", itemName: "T", itemAmount: "1", itemCode: "40237/XL" },
    { code: "20260739", date: "2026-04-30 15:45:25", statusName: "Vybavuje sa", billFullName: "Andrej", itemName: "T", itemAmount: "1", itemCode: "40237/XL" },
  ]);
  await ingestOrders(db, { fetchExport: () => Promise.resolve({ body: seed, sourceLabel: "seed" }), now: NOW, rawDir: dir, windowStart: WIDE_START, windowEnd: WIDE_END });
  const [seeded] = await db.select().from(orders).where(eq(orders.externalOrderId, "20260739"));
  expect(seeded?.statusName).toBe("Vybavuje sa");
}

it("BUG: pevné 90-dňové okno necháva starú vybavenú objednávku zamrznutú v 'Vybavuje sa'", async () => {
  const { db, dir } = await boot();
  await seedFrozenOldOrder(db, dir);

  // pevné okno (predfixové správanie): dateFrom ~28.5, stará objednávka (30.4) mimo neho
  const { dateFrom, dateUntil } = computeImportWindow(NOW, DEFAULT_ORDERS_IMPORT_WINDOW_DAYS);
  expect(dateFrom.getTime()).toBeGreaterThan(WINDOW_THRESHOLD.getTime()); // okno nesiaha po 30.4 → export ju vynechá
  await ingestOrders(db, { fetchExport: windowAwareFetcher(dateFrom), now: NOW, rawDir: dir, windowStart: dateFrom, windowEnd: dateUntil });

  const [old] = await db.select().from(orders).where(eq(orders.externalOrderId, "20260739"));
  expect(old?.statusName).toBe("Vybavuje sa"); // ZAMRZNUTÉ — export ju nezachytil
  expect(await listOpenStatusNames(db)).toContain(old?.statusName); // stále "otvorená"
});

it("FIX: sebaozdravujúce okno CSV importu dočíta starú objednávku a osvieži ju na 'Vybavená'", async () => {
  const { db, dir } = await boot();
  await seedFrozenOldOrder(db, dir);

  const { dateFrom: defaultFrom, dateUntil } = computeImportWindow(NOW, DEFAULT_ORDERS_IMPORT_WINDOW_DAYS);
  const exportFrom = await computeOrdersExportWindowStart(db, defaultFrom);
  expect(exportFrom.getTime()).toBeLessThanOrEqual(WINDOW_THRESHOLD.getTime()); // predĺžené po 30.4 → export ju zachytí
  await ingestOrders(db, { fetchExport: windowAwareFetcher(exportFrom), now: NOW, rawDir: dir, windowStart: exportFrom, windowEnd: dateUntil });

  const [old] = await db.select().from(orders).where(eq(orders.externalOrderId, "20260739"));
  // ASCII "Vybavena" v CSV (buildCsv je UTF-8, ingest dekóduje cp1250 → diakritika
  // by bola mojibake, rovnaký dôvod ako v orders-ingest.integration.test.ts); reálny
  // Shoptet nesie "Vybavená" v cp1250, čo sa dekóduje správne (naživo overené).
  expect(old?.statusName).toBe("Vybavena"); // osviežené zo Shoptetu (v teste ASCII)
  expect(await listOpenStatusNames(db)).not.toContain(old?.statusName); // vypadla z "Na objednanie"
});
