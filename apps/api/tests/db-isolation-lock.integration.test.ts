import pg from "pg";
import { afterEach, expect, it } from "vitest";
import { TEST_DB_ISOLATION_LOCK_KEY, withCleanDb } from "./helpers/db.js";

// issue #7 — withCleanDb() musí držať session advisory zámok od TRUNCATE po
// close(), aby dva súbežné procesy (dva terminály/agent session bežiace
// `pnpm test:integration` proti tej istej lokálnej Postgres, port 5433)
// nikdy neprekrývali TRUNCATE jedného s ešte prebiehajúcim testom druhého.
//
// Skutočná TRUNCATE-vs-insert kolízia je časovo nedeterministická (presne to
// varovanie v .claude/rules/testing.md), takže to dokazujeme
// DETERMINISTICKY: `pg_try_advisory_lock` (neblokujúci) z DRUHÉHO, nezávislého
// pripojenia musí zlyhať, kým je `withCleanDb()`-ov kontext otvorený, a uspieť
// hneď po `close()`.

let checker: pg.Client | undefined;

afterEach(async () => {
  await checker?.end();
  checker = undefined;
});

async function tryLockFromSeparateConnection(): Promise<boolean> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("Integračné testy potrebujú DATABASE_URL");
  }
  checker = new pg.Client({ connectionString: databaseUrl });
  await checker.connect();
  const result = await checker.query<{ pg_try_advisory_lock: boolean }>(
    "select pg_try_advisory_lock($1)",
    [TEST_DB_ISOLATION_LOCK_KEY],
  );
  const acquired = result.rows[0]?.pg_try_advisory_lock ?? false;
  if (acquired) {
    await checker.query("select pg_advisory_unlock($1)", [TEST_DB_ISOLATION_LOCK_KEY]);
  }
  await checker.end();
  checker = undefined;
  return acquired;
}

it("withCleanDb() drží advisory zámok od otvorenia po close(), takže súbežný withCleanDb() naň musí čakať", async () => {
  const ctx = await withCleanDb();

  // Kým je ctx otvorený, iné pripojenie nesmie ten istý zámok získať —
  // dnes (bez zámku vo withCleanDb()) by toto zlyhalo, lebo nikto zámok
  // vôbec neberie.
  expect(await tryLockFromSeparateConnection()).toBe(false);

  await ctx.close();

  // Po close() musí byť zámok voľný.
  expect(await tryLockFromSeparateConnection()).toBe(true);
});
