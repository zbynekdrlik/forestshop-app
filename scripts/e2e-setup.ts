// Pripraví databázu pre E2E beh: vymaže všetky riadky a založí presne jedného
// testovacieho používateľa. Beží pred štartom API servera (viď
// apps/web/playwright.config.ts) a je idempotentný — opakované spustenie
// necháva presne jedného používateľa vďaka TRUNCATE pred insertom.
//
// POZOR: mieri na tú istú lokálnu databázu ako integračné testy (DATABASE_URL
// z prostredia). To je v poriadku LEN preto, že tabuľky vždy najprv vyprázdni
// — nikdy nesmerovať na databázu, ktorá obsahuje reálne dáta.
import { createDb } from "../apps/api/src/db/client.js";
import { users } from "../apps/api/src/db/schema.js";
import { hashPassword } from "../apps/api/src/modules/auth/passwords.js";

const E2E_HESLO = "e2e-test-heslo"; // musí sa zhodovať s hodnotou v login.spec.ts

const { db, pool } = createDb();
// Konštantný literál bez interpolácie — obyčajný reťazec je tu rovnako bezpečný
// ako `sql` tagovaná šablóna (tú používa ekvivalentný apps/api/tests/helpers/db.ts),
// ale vyhne sa priamemu importu z "drizzle-orm" v tomto samostatnom skripte mimo
// TS projektu apps/api — ESLint-ova type-aware kontrola vtedy nevie spoľahlivo
// odvodiť typ tagovanej šablóny a hlási falošné @typescript-eslint/no-unsafe-*.
await db.execute("TRUNCATE TABLE audit_events, sessions, users RESTART IDENTITY CASCADE");
await db.insert(users).values({
  email: "e2e@forestshop.sk",
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await pool.end();
