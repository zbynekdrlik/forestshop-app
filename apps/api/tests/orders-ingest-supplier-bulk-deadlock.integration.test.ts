import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterEach, expect, it } from "vitest";
import { orderLines, orders } from "../src/db/schema.js";
import { ingestOrders, type OrdersExportFetcher } from "../src/modules/orders/ingest.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 416 (code review on issue 412): `ingestOrders`'s reconciliation
// DELETE (`order_line.ts`, added by issue 412) locks `order` rows FIRST
// (main upsert), then `order_line` rows (upsert + DELETE) — in that order,
// same transaction. `queries.ts`'s `listOpenOrderLineIdsForSupplier`
// (called by `state.ts`'s `setSupplierLinesOrdered`, the "mark whole
// supplier group as ordered" bulk action) runs `.for("update", { of:
// [orderLines, orders] })` across a JOIN — Postgres locks the rows of BOTH
// tables as the query PLAN visits them, in whatever order the planner
// chooses, theoretically the OPPOSITE order (order_line first, then
// order). When both transactions touch the SAME order concurrently, that
// is a textbook AB-BA lock-ordering deadlock risk.
//
// This is NOT a new risk introduced by issue 412 — the exact same
// order -> order_line ordering has been held by the pre-existing
// order_line upsert cycle for years; issue 412 only adds one more
// order_line touch (the DELETE) to the same transaction.
//
// This test does NOT rely on the query planner actually choosing the
// worst-case order (unverifiable, could differ by Postgres version/data
// volume, and a natural `Promise.all` race would make the test
// non-deterministic — see the design comment on issue 416 for the two
// rejected alternatives). Instead it DETERMINISTICALLY ORCHESTRATES the
// exact worst case via two raw connections around a REAL `ingestOrders`
// call (same technique as `orders-supplier-bulk-lock.integration.test.ts`
// and `orders-ingest-return-upozornenie-lock.integration.test.ts`: a
// second connection holds real row locks exactly where the risk sits,
// `pg_stat_activity`/`pg_blocking_pids` polling instead of timing):
//
//   1. rawClient locks the EXISTING order_line row (order_line -> order,
//      the worst-case direction).
//   2. The real `ingestOrders(...)` runs a CSV that swaps the order's
//      product (same scenario as issue 412's own regression test) — its
//      upsert locks the `order` row fine, then its reconciliation DELETE
//      needs the order_line row rawClient holds -> blocks.
//   3. rawClient THEN locks the `order` row too -> now blocks on
//      ingestOrders's own (still-open) transaction, which holds it from
//      step 2's upsert. A genuine two-way cycle now exists.
//
// Goal (per the ticket): prove Postgres's deadlock detector ALWAYS safely
// resolves this — bounded resolution time (no hang/starvation), exactly
// one side aborted with the real Postgres deadlock error (40P01), and the
// DB left fully consistent either way (never a partial write) — or, if a
// longer hang were found instead, propose a lock-order fix.

const WINDOW_START = new Date("2020-01-01T00:00:00Z");
const WINDOW_END = new Date("2030-01-01T00:00:00Z");
const NOW = new Date("2026-07-30T10:00:00Z");
const DEADLOCK_TEST_TIMEOUT_MS = 45_000;

const HEADER = ["code", "date", "statusName", "billFullName", "itemName", "itemAmount", "itemCode"] as const;

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
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-orders-deadlock-raw-"));
  return { db: ctx.db, dir: rawDir };
}

async function getBackendPid(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error("nepodarilo sa zistiť backend pid");
  return pid;
}

// Nájde backend (client backend, mimo zoznamu vylúčených pid), ktorý je
// PRÁVE TERAZ zaseknutý na zámku drženom `blockerPid` — `pg_blocking_pids`
// dokazuje SPECIFICKY tento blokujúci vzťah, nie len "niekto niekde čaká"
// (ten istý dôvod ako `orders-ingest-return-upozornenie-lock.integration
// .test.ts`'s druhé kolo review — box môže byť zdieľaný s inou aktivitou).
async function findBackendBlockedBy(pollClient: pg.Client, blockerPid: number, excludePids: readonly number[], deadlineMs = 5000): Promise<number> {
  const start = Date.now();
  for (;;) {
    const { rows } = await pollClient.query<{ pid: number }>(
      "SELECT a.pid AS pid FROM pg_stat_activity a" +
        " WHERE a.wait_event_type = 'Lock' AND a.backend_type = 'client backend'" +
        " AND a.pid <> ALL($1::int[]) AND $2 = ANY (pg_blocking_pids(a.pid))",
      [excludePids, blockerPid],
    );
    const pid = rows[0]?.pid;
    if (pid !== undefined) return pid;
    if (Date.now() - start > deadlineMs) {
      throw new Error(`Žiadny backend sa v ${String(deadlineMs)}ms nezasekol na zámku drženom pid ${String(blockerPid)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Overí DRUHÚ polovicu cyklu: `waiterPid` je PRÁVE TERAZ zaseknutý presne
// na zámku drženom `blockerPid`.
async function waitUntilBlockedBy(pollClient: pg.Client, waiterPid: number, blockerPid: number, deadlineMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const { rows } = await pollClient.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity a" + " WHERE a.pid = $1 AND a.wait_event_type = 'Lock' AND $2 = ANY (pg_blocking_pids(a.pid))",
      [waiterPid, blockerPid],
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() - start > deadlineMs) {
      throw new Error(`pid ${String(waiterPid)} sa v ${String(deadlineMs)}ms nezaseklo na zámku drženom pid ${String(blockerPid)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

it(
  "reconciliation DELETE vs. hromadné 'objednané': skutočný AB-BA cyklus sa vyrieši rýchlym Postgres deadlock-abortom, nikdy nekonečným zaseknutím/hladovaním",
  async () => {
    const { db, dir } = await boot();
    await insertTestVariant(db, "DL-A", "Dodávateľ Deadlock");
    await insertTestVariant(db, "DL-B", "Dodávateľ Deadlock");

    const povodna = buildCsv([
      { code: "8001", date: "2026-07-01 10:00:00", statusName: "Vybavuje sa", billFullName: "Zákazník Deadlock", itemName: "Produkt A", itemAmount: "1", itemCode: "DL-A" },
    ]);
    const prvyImport = await ingestOrders(db, { fetchExport: fetcherOf(povodna), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
    expect(prvyImport.status).toBe("accepted");

    const [objednavka] = await db.select().from(orders).where(eq(orders.externalOrderId, "8001"));
    if (objednavka === undefined) throw new Error("objednávka sa nenašla");
    const [staryRiadok] = await db.select().from(orderLines).where(eq(orderLines.orderId, objednavka.id));
    if (staryRiadok === undefined) throw new Error("riadok sa nenašiel");

    // Druhý export: produkt vymenený DL-A -> DL-B (rovnaký scenár ako issue
    // 412's vlastný regresný test) — vynúti reálny DELETE krok na
    // `staryRiadok`.
    const zmenena = buildCsv([
      { code: "8001", date: "2026-07-01 10:00:00", statusName: "Vybavuje sa", billFullName: "Zákazník Deadlock", itemName: "Produkt B", itemAmount: "1", itemCode: "DL-B" },
    ]);

    const databaseUrl = process.env["DATABASE_URL"];
    if (databaseUrl === undefined || databaseUrl === "") throw new Error("Integračné testy potrebujú DATABASE_URL");
    const rawClient = new pg.Client({ connectionString: databaseUrl });
    const pollClient = new pg.Client({ connectionString: databaseUrl });
    await rawClient.connect();
    await pollClient.connect();
    const rawClientPid = await getBackendPid(rawClient);
    const pollClientPid = await getBackendPid(pollClient);

    let ingestSettled: PromiseSettledResult<Awaited<ReturnType<typeof ingestOrders>>> | undefined;
    let orderLockSettled: PromiseSettledResult<pg.QueryResult<{ id: string }>> | undefined;

    await rawClient.query("BEGIN");
    // KROK 1: zamkne `order_line` riadok PRED `order` riadkom — opačné
    // poradie, aké má `ingestOrders`'s vlastný upsert cyklus.
    await rawClient.query('SELECT id FROM order_line WHERE id = $1 FOR UPDATE', [staryRiadok.id]);

    try {
      const ingestPromise = ingestOrders(db, { fetchExport: fetcherOf(zmenena), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });

      // Prvá polovica cyklu: PRÁVE TENTO (ingestOrders's) backend, a žiadny
      // iný, sa zasekol presne na rawClient's order_line zámku.
      const ingestBackendPid = await findBackendBlockedBy(pollClient, rawClientPid, [rawClientPid, pollClientPid]);

      const cycleFormedAt = Date.now();
      // KROK 2: rawClient TERAZ zamkne `order` riadok TEJ ISTEJ objednávky —
      // ten drží `ingestOrders`'s vlastná (ešte neuzavretá) transakcia od
      // jej úvodného upsertu. Cyklus je uzavretý: ingestOrders čaká na
      // rawClient (order_line), rawClient čaká na ingestOrders (order).
      const orderLockPromise = rawClient.query<{ id: string }>('SELECT id FROM "order" WHERE id = $1 FOR UPDATE', [objednavka.id]);

      // Druhá polovica cyklu, deterministicky potvrdená.
      await waitUntilBlockedBy(pollClient, rawClientPid, ingestBackendPid);

      [ingestSettled, orderLockSettled] = await Promise.allSettled([ingestPromise, orderLockPromise]);
      const resolvedWithinMs = Date.now() - cycleFormedAt;

      // Postgresov deadlock detektor beží na `deadlock_timeout` (predvolene
      // 1s) — 10s je veľkorysá rezerva nad tým (ďaleko pod 45s test
      // timeoutom), ale STÁLE ďaleko pod tým, ako by vyzeralo skutočné
      // hladovanie (appka by import zopakovala o hodinu, nie čakala minúty).
      expect(resolvedWithinMs).toBeLessThan(10_000);

      const ingestRejected = ingestSettled.status === "rejected";
      const orderLockRejected = orderLockSettled.status === "rejected";
      // PRÁVE JEDNA strana je obeť deadlocku — nikdy obe (to by nebol
      // deadlock, len súčasné zlyhanie z iného dôvodu), nikdy žiadna (to by
      // znamenalo, že cyklus vôbec nevznikol).
      expect(ingestRejected).not.toBe(orderLockRejected);

      if (ingestRejected) {
        expect(postgresErrorCode((ingestSettled as PromiseRejectedResult).reason)).toBe("40P01");
      } else {
        expect(postgresErrorCode((orderLockSettled as PromiseRejectedResult).reason)).toBe("40P01");
      }
    } finally {
      // rawClient's transakcia je po deadlock-abortoch VŽDY buď aborted
      // (ak bol OBEŤOU), alebo stále otvorená s nekomitnutými zámkami (ak
      // VYHRAL) — ROLLBACK ju v OBOCH prípadoch bezpečne uzavrie (rawClient
      // nikdy nič nezapisuje, len drží zámky na overenie).
      await rawClient.query("ROLLBACK").catch(() => undefined);
      await rawClient.end();
      await pollClient.end();
    }

    // Konzistencia DB PO doriešení — NIKDY čiastočný zápis, bez ohľadu na
    // to, ktorá strana bola obeťou (Postgresova transakčná atomicita —
    // appkin vlastný kód nepridáva žiadne čiastočné-zápisové cesty, viď
    // `ingest.ts`'s vonkajší catch, ktorý len loguje + znovu vyhodí).
    const riadkyPo = await db.select().from(orderLines).where(eq(orderLines.orderId, objednavka.id));
    if (ingestSettled.status === "fulfilled") {
      // ingestOrders vyhral: reconciliation DOKONČENÁ presne ako v issue
      // 412's vlastnom teste — DL-A preč, DL-B pribudlo.
      expect(ingestSettled.value.status).toBe("accepted");
      if (ingestSettled.value.status === "accepted") {
        expect(ingestSettled.value.deletedStaleLineCount).toBe(1);
      }
      expect(riadkyPo).toHaveLength(1);
      expect(riadkyPo[0]?.variantCode).toBe("DL-B");
    } else {
      // ingestOrders bol obeťou: CELÁ jeho transakcia sa rollbackla —
      // pôvodný stav (DL-A, ten istý riadok) prežil bezo zmeny, nikdy
      // čiastočne zapísaný DL-B ani zmazaný DL-A.
      expect(riadkyPo).toHaveLength(1);
      expect(riadkyPo[0]?.variantCode).toBe("DL-A");
      expect(riadkyPo[0]?.id).toBe(staryRiadok.id);
    }
  },
  DEADLOCK_TEST_TIMEOUT_MS,
);
