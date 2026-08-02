import { sql } from "drizzle-orm";
import pg from "pg";
import { createDb, type Database } from "../../src/db/client.js";
import { orderOpenStatuses, postaUncollectedSettings } from "../../src/db/schema.js";
import { DEFAULT_ORDER_OPEN_STATUS } from "../../src/modules/orders/open-statuses.js";
import { POSTA_UNCOLLECTED_SETTINGS_ID } from "../../src/modules/posta-uncollected/settings.js";

/**
 * Distinct advisory-lock key for serializing `withCleanDb()` across
 * concurrent OS processes sharing the same local dev Postgres (issue #7) —
 * pg_advisory_lock/pg_advisory_xact_lock share ONE keyspace regardless of
 * which function takes it (see catalog-ingest-lock.integration.test.ts), so
 * this must never collide with INGEST_ADVISORY_LOCK_KEY (787_878_001).
 */
export const TEST_DB_ISOLATION_LOCK_KEY = 787_878_100;

export async function withCleanDb(): Promise<{ db: Database; close: () => Promise<void> }> {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error("Integračné testy potrebujú DATABASE_URL na testovaciu databázu");
  }

  // pg_advisory_lock is per-SESSION (per backend connection), so it must be
  // taken on its own dedicated connection, not through the pool `db` below
  // shares across queries — held from here until close() releases it, so a
  // second, concurrent withCleanDb() (another agent/terminal running
  // `pnpm test:integration` against the same DATABASE_URL) blocks until this
  // test's whole TRUNCATE-and-use span is done, instead of interleaving.
  const lock = new pg.Client({ connectionString: url });
  await lock.connect();
  await lock.query("select pg_advisory_lock($1)", [TEST_DB_ISOLATION_LOCK_KEY]);

  const { db, pool } = createDb(url);
  try {
    // "order_line"/"order" (order.ts) added explicitly, not left to CASCADE —
    // order_line references variant (CASCADE from variant would clear it), but
    // "order" itself has no FK into any of the other listed tables, so CASCADE
    // never reaches it: without listing it here, rows would silently survive
    // across tests. "order" is a reserved SQL keyword and must be quoted.
    // "supplier_contact" (#31) has NO foreign key at all (keyed on the
    // supplier NAME string, not an id) — CASCADE never reaches it from any
    // direction, so it must be listed explicitly too, same reasoning as
    // "order" above. "supplier" (#44) is the SAME situation — also keyed on
    // the supplier NAME string, no FK at all. "pairing" (#44) DOES have an FK
    // into "variant" so `TRUNCATE variant CASCADE` already reaches it — listed
    // explicitly anyway for the same self-documenting reason "order_line" is.
    // "order_open_status" (issue 59) is the SAME situation again — no FK in
    // either direction (keyed on a free-text status name) — CASCADE never
    // reaches it. "posta_uncollected_settings"/"posta_uncollected_state"
    // (issue 172) are the SAME situation too — no FK in either direction
    // (singleton id / order-code keyed).
    await db.execute(
      sql`TRUNCATE TABLE ingest_issue, variant, product, catalog_snapshot, job_run, audit_events, sessions, users, order_line, "order", supplier_contact, pairing, supplier, order_open_status, posta_uncollected_settings, posta_uncollected_state RESTART IDENTITY CASCADE`,
    );
    // issue 59: `order_open_status` is a NEW table with real production
    // content (the migration seeds it) — TRUNCATE alone would leave every
    // test starting from an EMPTY set, silently blanking `listOpenOrderLinesBySupplier`
    // for every test that relies on the default open behavior (nearly all of
    // them). Re-seed the same default the migration writes on a fresh
    // install, so each test starts from the identical "just migrated" state.
    await db.insert(orderOpenStatuses).values({ statusName: DEFAULT_ORDER_OPEN_STATUS });
    // issue 172: `posta_uncollected_settings` is the SAME situation as
    // `order_open_status` above — the migration seeds its singleton row
    // (`enabled=false`), so every test must start from that same
    // just-migrated state, not an empty table.
    await db.insert(postaUncollectedSettings).values({ id: POSTA_UNCOLLECTED_SETTINGS_ID, enabled: false });
  } catch (err) {
    try {
      await pool.end();
    } finally {
      await lock.query("select pg_advisory_unlock($1)", [TEST_DB_ISOLATION_LOCK_KEY]);
      await lock.end();
    }
    throw err;
  }

  return {
    db,
    close: async () => {
      try {
        await pool.end();
      } finally {
        // Release the lock even if pool.end() throws — otherwise the
        // dedicated lock connection (and the lock itself) would leak until
        // the test process exits, blocking every other concurrent
        // withCleanDb() for no good reason.
        await lock.query("select pg_advisory_unlock($1)", [TEST_DB_ISOLATION_LOCK_KEY]);
        await lock.end();
      }
    },
  };
}
