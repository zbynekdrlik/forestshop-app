import { sql } from "drizzle-orm";
import { createDb, type Database } from "../../src/db/client.js";

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
  const { db, pool } = createDb(url);
  try {
    await db.execute(
      sql`TRUNCATE TABLE ingest_issue, variant, product, catalog_snapshot, audit_events, sessions, users RESTART IDENTITY CASCADE`,
    );
  } catch (err) {
    await pool.end();
    throw err;
  }
  return { db, close: () => pool.end() };
}
