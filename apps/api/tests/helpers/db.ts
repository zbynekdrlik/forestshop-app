import { sql } from "drizzle-orm";
import { createDb, type Database } from "../../src/db/client.js";

export async function withCleanDb(): Promise<{ db: Database; close: () => Promise<void> }> {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error("Integračné testy potrebujú DATABASE_URL na testovaciu databázu");
  }
  const { db, pool } = createDb(url);
  await db.execute(sql`TRUNCATE TABLE audit_events, sessions, users RESTART IDENTITY CASCADE`);
  return { db, close: () => pool.end() };
}
