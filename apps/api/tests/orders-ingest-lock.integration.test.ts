import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, expect, it } from "vitest";
import { orderLines, orders } from "../src/db/schema.js";
import { INGEST_ORDERS_ADVISORY_LOCK_KEY, ingestOrders, type OrdersExportFetcher } from "../src/modules/orders/ingest.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// Vydelené do vlastného súboru — rovnaký dôvod ako katalógov
// `catalog-ingest-lock.integration.test.ts`.

const WINDOW_START = new Date("2020-01-01T00:00:00Z");
const WINDOW_END = new Date("2030-01-01T00:00:00Z");
const NOW = new Date("2026-07-30T10:00:00Z");

const HEADER = ["code", "date", "billFullName", "itemName", "itemAmount", "itemCode"] as const;

function buildCsv(rows: readonly Record<string, string>[]): Buffer {
  const esc = (v: string): string => `"${v.replaceAll('"', '""')}"`;
  const lines = [HEADER.map(esc).join(";") + ";"];
  for (const row of rows) lines.push(HEADER.map((c) => esc(row[c] ?? "")).join(";") + ";");
  return Buffer.from(lines.join("\r\n") + "\r\n", "utf-8");
}

function fetcherOf(body: Buffer): OrdersExportFetcher {
  return () => Promise.resolve({ body, sourceLabel: "fixtúra" });
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
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-orders-raw-"));
  return { db: ctx.db, dir: rawDir };
}

// Rovnaký dôkaz ako katalógov lock-test (Important #6 tam): brána prijatia
// (previousLineCount) sa MUSÍ čítať AŽ PO získaní `pg_advisory_xact_lock`, nie
// pred otvorením transakcie — inak by dva súbežné importy mohli posudzovať
// proti tomu istému zastaranému základu.
it("základ pre bránu prijatia sa číta AŽ PO získaní advisory zámku, nie pred otvorením transakcie", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40999/X");

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("Integračné testy potrebujú DATABASE_URL");
  }
  const lockHolder = new pg.Client({ connectionString: databaseUrl });
  await lockHolder.connect();
  await lockHolder.query("select pg_advisory_lock($1)", [INGEST_ORDERS_ADVISORY_LOCK_KEY]);

  try {
    // 1 použiteľný riadok: proti základu 0 (žiadny baseline zapísaný ešte) by
    // prešiel (trust-on-first-use); proti základu 100 (podlaha 20), ktorý test
    // o chvíľu vloží PRIAMO počas zaseknutia na zámku, musí byť odmietnutý.
    const smallImport = ingestOrders(db, {
      fetchExport: fetcherOf(buildCsv([{ code: "NEW-1", date: "2026-05-01 10:00:00", billFullName: "Y", itemName: "Z", itemAmount: "1", itemCode: "40999/X" }])),
      now: NOW,
      rawDir: dir,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    // Dá malému importu dosť času dôjsť až k `pg_advisory_xact_lock` a zaseknúť
    // sa tam — zámok drží `lockHolder`, takže "príliš neskoro" tu nehrozí.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Simuluje druhý, medzitým commitnutý import s väčším základom — vložené
    // PRIAMO (mimo ingestOrders), presne v momente, keď je malý import
    // zaseknutý na zámku.
    for (let i = 0; i < 100; i += 1) {
      const [order] = await db
        .insert(orders)
        .values({ externalOrderId: `CONCURRENT-${String(i)}`, customerName: "Test", placedAt: new Date("2026-05-01T00:00:00Z") })
        .returning();
      if (order === undefined) throw new Error("insert zlyhal");
      await db.insert(orderLines).values({ orderId: order.id, variantCode: "40999/X", quantity: 1 });
    }

    await lockHolder.query("select pg_advisory_unlock($1)", [INGEST_ORDERS_ADVISORY_LOCK_KEY]);
    const result = await smallImport;

    expect(result.status).toBe("rejected");
    // "100" v dôvode dokazuje, že brána použila ČERSTVO vložený (väčší)
    // základ, nie základ spred neho (0) — presne to, čo test overuje.
    expect(result.status === "rejected" && result.reason).toContain("100");
  } finally {
    await lockHolder.end();
  }
});
