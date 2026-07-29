import { sql } from "drizzle-orm";
import { createDb, type Database } from "../../src/db/client.js";

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
