import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import pg from "pg";
import { afterEach, expect, it } from "vitest";
import { orderLines, orderOpenStatuses, orders } from "../src/db/schema.js";
import { backfillOpenOrders, type BackfillExportWindow } from "../src/modules/orders/backfill-open.js";
import { upsertOrdersAndLines } from "../src/modules/orders/ingest-materialize.js";
import type { OrderIdsFetcher } from "../src/modules/orders/fetcher.js";
import { INGEST_ORDERS_ADVISORY_LOCK_KEY, ingestOrders, type OrdersExportFetcher } from "../src/modules/orders/ingest.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 595: objednávka OTVORENÁ v Shoptete, ale staršia než úplne prvý import
// (20260707, Šulcová, 24. 4. 2026 — najstaršia objednávka v DB je z 30. 4.), sa
// nikdy nenačíta: `computeOrdersExportWindowStart` (issue 492) predlžuje okno
// iba po najstaršiu otvorenú objednávku, ktorá UŽ JE v DB. Jednorazový doimport
// (`backfillOpenOrders`, CLI `orders-backfill-open`) stiahne export za
// `[from, najstaršia objednávka v DB]` a zapíše LEN otvorené objednávky, ktoré v
// DB ešte nie sú — nič existujúce nezmení ani nezmaže, opakovaný beh nič nepridá.
//
// ASCII-only CSV (buildCsv je UTF-8, ingest dekóduje cp1250) — rovnaký dôvod ako
// `orders-ingest.integration.test.ts`; "Vybavena" (bez diakritiky) je tu
// jednoducho NEotvorený stav, otvorený je predvolený "Vybavuje sa".

const HEADER = ["code", "date", "statusName", "billFullName", "itemName", "itemAmount", "itemCode"] as const;

function buildCsv(rows: readonly Record<string, string>[]): Buffer {
  const esc = (v: string): string => `"${v.replaceAll('"', '""')}"`;
  const lines = [HEADER.map(esc).join(";") + ";"];
  for (const row of rows) lines.push(HEADER.map((c) => esc(row[c] ?? "")).join(";") + ";");
  return Buffer.from(lines.join("\r\n") + "\r\n", "utf-8");
}

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
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-orders-backfill-open-"));
  return { db: ctx.db, dir: rawDir };
}

const NOW = new Date("2026-10-19T10:00:00Z");
const FROM = new Date("2025-01-01T00:00:00Z");
const WIDE_START = new Date("2020-01-01T00:00:00Z");
const WIDE_END = new Date("2030-01-01T00:00:00Z");

// Stav DB "po prvom importe": najstaršia objednávka 9300 (30. 4., otvorená, riadok
// 60028/XL, manažérov komentár + posunutý stav riadku) a 9301 (10. 5., uzavretá).
async function seedExisting(db: Awaited<ReturnType<typeof withCleanDb>>["db"], dir: string): Promise<void> {
  await insertTestVariant(db, "60028/XL", "RUTEX");
  await insertTestVariant(db, "60029/XL", "RUTEX");
  await insertTestVariant(db, "40237/XL");
  const seed = buildCsv([
    { code: "9300", date: "2026-04-30 15:45:25", statusName: "Vybavuje sa", billFullName: "Prva", itemName: "T", itemAmount: "1", itemCode: "60028/XL" },
    { code: "9301", date: "2026-05-10 09:00:00", statusName: "Vybavena", billFullName: "Druha", itemName: "T", itemAmount: "1", itemCode: "40237/XL" },
  ]);
  const seeded = await ingestOrders(db, {
    fetchExport: () => Promise.resolve({ body: seed, sourceLabel: "seed" }),
    now: NOW,
    rawDir: dir,
    windowStart: WIDE_START,
    windowEnd: WIDE_END,
  });
  expect(seeded.status).toBe("accepted");
  await db.update(orders).set({ comment: "manazerov komentar" }).where(eq(orders.externalOrderId, "9300"));
  await db.update(orderLines).set({ state: "riesit" });
}

// Export za staršie obdobie: otvorená stará (20260707, dva produkty), uzavretá
// stará (20260600) a EXISTUJÚCA 9300 so zmeneným produktom + menom — tú
// doimport nesmie zmeniť (žiadne mazanie riadkov, žiadny prepis polí).
const OLD_EXPORT = buildCsv([
  { code: "20260707", date: "2026-04-24 11:12:00", statusName: "Vybavuje sa", billFullName: "Monika Sulcova", itemName: "Bunda", itemAmount: "1", itemCode: "60028/XL" },
  { code: "20260707", date: "2026-04-24 11:12:00", statusName: "Vybavuje sa", billFullName: "Monika Sulcova", itemName: "Nohavice", itemAmount: "2", itemCode: "60029/XL" },
  { code: "20260600", date: "2026-03-01 08:00:00", statusName: "Vybavena", billFullName: "Stara Uzavreta", itemName: "T", itemAmount: "1", itemCode: "40237/XL" },
  { code: "9300", date: "2026-04-30 15:45:25", statusName: "Vybavuje sa", billFullName: "Prepisane Meno", itemName: "T", itemAmount: "1", itemCode: "60029/XL" },
]);

function recordingFetcher(body: Buffer, windows: BackfillExportWindow[]): (w: BackfillExportWindow) => OrdersExportFetcher {
  return (w) => {
    windows.push(w);
    return () => Promise.resolve({ body, sourceLabel: "fixtura" });
  };
}

const ids: (w: BackfillExportWindow) => OrderIdsFetcher = () => () => Promise.resolve(new Map([["20260707", 58088]]));

it("doimportuje LEN starú OTVORENÚ objednávku, uzavretú vynechá a existujúce objednávky/riadky nechá bez zmeny", async () => {
  const { db, dir } = await boot();
  await seedExisting(db, dir);
  const [oldest] = await db.select({ placedAt: orders.placedAt }).from(orders).where(eq(orders.externalOrderId, "9300"));
  const windows: BackfillExportWindow[] = [];

  const result = await backfillOpenOrders(db, {
    from: FROM,
    now: NOW,
    rawDir: dir,
    createExportFetcher: recordingFetcher(OLD_EXPORT, windows),
    createOrderIdsFetcher: ids,
  });

  // okno exportu = [--from, najstaršia objednávka v DB + 1 deň] — Shoptet berie
  // `dateUntil` ako kalendárny dátum (formatDateParam = UTC deň), takže +1 deň
  // pokryje celý miestny deň najstaršej objednávky aj okolo polnoci; prekryv s už
  // naimportovanými objednávkami odfiltruje "už v DB" (review, issue 595).
  expect(windows).toHaveLength(1);
  expect(windows[0]?.dateFrom.toISOString()).toBe(FROM.toISOString());
  expect(windows[0]?.dateUntil.toISOString()).toBe(new Date((oldest?.placedAt.getTime() ?? 0) + 86_400_000).toISOString());

  expect(result).toMatchObject({
    status: "accepted",
    readOrderCount: 3,
    openOrderCount: 2,
    alreadyPresentCount: 1,
    insertedOrderCount: 1,
    insertedLineCount: 2,
  });

  const [sulcova] = await db.select().from(orders).where(eq(orders.externalOrderId, "20260707"));
  expect(sulcova?.statusName).toBe("Vybavuje sa");
  expect(sulcova?.customerName).toBe("Monika Sulcova");
  expect(sulcova?.shoptetOrderId).toBe(58088); // XML id ako pri bežnom importe
  const sulcovaLines = await db
    .select({ variantCode: orderLines.variantCode, quantity: orderLines.quantity })
    .from(orderLines)
    .where(eq(orderLines.orderId, sulcova?.id ?? ""))
    .orderBy(asc(orderLines.variantCode));
  expect(sulcovaLines).toEqual([
    { variantCode: "60028/XL", quantity: 1 },
    { variantCode: "60029/XL", quantity: 2 },
  ]);

  // uzavretá stará objednávka sa NEzapísala
  expect(await db.select().from(orders).where(eq(orders.externalOrderId, "20260600"))).toHaveLength(0);

  // existujúca 9300: meno, komentár, riadok aj jeho stav bez zmeny; nový produkt z exportu NEpridaný
  const [existing] = await db.select().from(orders).where(eq(orders.externalOrderId, "9300"));
  expect(existing?.customerName).toBe("Prva");
  expect(existing?.comment).toBe("manazerov komentar");
  const existingLines = await db
    .select({ variantCode: orderLines.variantCode, state: orderLines.state })
    .from(orderLines)
    .where(eq(orderLines.orderId, existing?.id ?? ""));
  expect(existingLines).toEqual([{ variantCode: "60028/XL", state: "riesit" }]);

  // spolu: 9300, 9301, 20260707
  expect(await db.select({ id: orders.id }).from(orders)).toHaveLength(3);
});

it("opakovaný beh nič nepridá ani nezduplikuje", async () => {
  const { db, dir } = await boot();
  await seedExisting(db, dir);
  const opts = { from: FROM, now: NOW, rawDir: dir, createExportFetcher: recordingFetcher(OLD_EXPORT, []), createOrderIdsFetcher: ids };

  const first = await backfillOpenOrders(db, opts);
  expect(first).toMatchObject({ status: "accepted", insertedOrderCount: 1 });
  const linesAfterFirst = await db.select({ id: orderLines.id }).from(orderLines);

  const second = await backfillOpenOrders(db, opts);
  expect(second).toMatchObject({ status: "accepted", insertedOrderCount: 0, insertedLineCount: 0 });
  expect(await db.select({ id: orders.id }).from(orders)).toHaveLength(3);
  expect(await db.select({ id: orderLines.id }).from(orderLines)).toHaveLength(linesAfterFirst.length);
});

it("prázdna DB → odmietnuté bez sťahovania (na prvý import je bežný orders-ingest)", async () => {
  const { db, dir } = await boot();
  const windows: BackfillExportWindow[] = [];

  const result = await backfillOpenOrders(db, { from: FROM, now: NOW, rawDir: dir, createExportFetcher: recordingFetcher(OLD_EXPORT, windows) });

  expect(result.status).toBe("rejected");
  expect(windows).toHaveLength(0);
});

it("--from nie je staršie než najstaršia objednávka v DB → odmietnuté bez sťahovania", async () => {
  const { db, dir } = await boot();
  await seedExisting(db, dir);
  const windows: BackfillExportWindow[] = [];

  const result = await backfillOpenOrders(db, {
    from: new Date("2026-05-01T00:00:00Z"),
    now: NOW,
    rawDir: dir,
    createExportFetcher: recordingFetcher(OLD_EXPORT, windows),
  });

  expect(result.status).toBe("rejected");
  expect(windows).toHaveLength(0);
});

it("poškodený export (počet polí nesedí) → odmietnuté, DB bez zmeny", async () => {
  const { db, dir } = await boot();
  await seedExisting(db, dir);
  const broken = Buffer.from(
    [`"code";"date";"statusName";"billFullName";"itemName";"itemAmount";"itemCode";`, `"20260707";"2026-04-24 11:12:00";"Vybavuje sa";`].join("\r\n") + "\r\n",
    "utf-8",
  );

  const result = await backfillOpenOrders(db, { from: FROM, now: NOW, rawDir: dir, createExportFetcher: recordingFetcher(broken, []) });

  expect(result.status).toBe("rejected");
  expect(await db.select({ id: orders.id }).from(orders)).toHaveLength(2);
});

it("žiadny nastavený otvorený stav → odmietnuté (nie zavádzajúce 'nič nechýba'), DB bez zmeny", async () => {
  const { db, dir } = await boot();
  await seedExisting(db, dir);
  await db.delete(orderOpenStatuses);

  const result = await backfillOpenOrders(db, { from: FROM, now: NOW, rawDir: dir, createExportFetcher: recordingFetcher(OLD_EXPORT, []) });

  expect(result.status).toBe("rejected");
  expect(result.status === "rejected" && result.reason).toContain("otvorený stav");
  expect(await db.select({ id: orders.id }).from(orders)).toHaveLength(2);
});

it("existenciu v DB overuje AŽ PO advisory zámku importu (787_878_003) — súbežne vložená objednávka sa neprepíše", async () => {
  const { db, dir } = await boot();
  await seedExisting(db, dir);
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") throw new Error("Integračné testy potrebujú DATABASE_URL");
  const lockHolder = new pg.Client({ connectionString: databaseUrl });
  await lockHolder.connect();
  await lockHolder.query("select pg_advisory_lock($1)", [INGEST_ORDERS_ADVISORY_LOCK_KEY]);

  try {
    const pending = backfillOpenOrders(db, { from: FROM, now: NOW, rawDir: dir, createExportFetcher: recordingFetcher(OLD_EXPORT, []) });
    // Deterministicky (nie len časovaním): počkaj, kým doimport naozaj ČAKÁ na zámok.
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
      const res = await lockHolder.query<{ n: string }>(
        "select count(*)::text as n from pg_locks where locktype = 'advisory' and objid = $1 and not granted",
        [INGEST_ORDERS_ADVISORY_LOCK_KEY],
      );
      waiting = res.rows[0]?.n !== "0";
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(waiting).toBe(true);
    // simuluje bežný import, ktorý 20260707 medzitým zapísal
    await db.insert(orders).values({ externalOrderId: "20260707", customerName: "Z importu", placedAt: new Date("2026-04-24T09:12:00Z") });
    await lockHolder.query("select pg_advisory_unlock($1)", [INGEST_ORDERS_ADVISORY_LOCK_KEY]);

    const result = await pending;
    expect(result).toMatchObject({ status: "accepted", insertedOrderCount: 0, alreadyPresentCount: 2 });
    const [row] = await db.select().from(orders).where(eq(orders.externalOrderId, "20260707"));
    expect(row?.customerName).toBe("Z importu");
  } finally {
    await lockHolder.end();
  }
});

it("upsertOrdersAndLines 'insert-only': existujúcu objednávku NEprepíše — zhodí transakciu (fail-loud)", async () => {
  const { db, dir } = await boot();
  await seedExisting(db, dir);
  const prepis = {
    customerName: "Prepis",
    placedAt: new Date("2026-04-30T13:45:25Z"),
    statusName: "Vybavuje sa",
    remark: null,
    shopRemark: null,
    totalPriceWithVat: null,
  };

  await expect(
    db.transaction((tx) =>
      upsertOrdersAndLines(tx, {
        orderInfo: new Map([["9300", prepis]]),
        orderExtraByCode: new Map(),
        orderIdsByCode: new Map(),
        lines: [],
        conflict: "insert-only",
      }),
    ),
  ).rejects.toThrow("9300");
  const [row] = await db.select().from(orders).where(eq(orders.externalOrderId, "9300"));
  expect(row?.customerName).toBe("Prva");
});
