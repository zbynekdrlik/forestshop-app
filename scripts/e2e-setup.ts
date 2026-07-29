// Pripraví databázu pre E2E beh: vymaže všetky riadky a založí presne jedného
// testovacieho používateľa. Beží pred štartom API servera (viď
// apps/web/playwright.config.ts) a je idempotentný — opakované spustenie
// necháva presne jedného používateľa vďaka TRUNCATE pred insertom.
//
// POZOR: mieri na tú istú lokálnu databázu ako integračné testy (DATABASE_URL
// z prostredia). To je v poriadku LEN preto, že tabuľky vždy najprv vyprázdni
// — nikdy nesmerovať na databázu, ktorá obsahuje reálne dáta.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb } from "../apps/api/src/db/client.js";
import { users } from "../apps/api/src/db/schema.js";
import { hashPassword } from "../apps/api/src/modules/auth/passwords.js";
import { ingestCatalog } from "../apps/api/src/modules/catalog/ingest.js";
import { DEFAULT_SNAPSHOT_LIMITS } from "../apps/api/src/modules/catalog/validation.js";

const E2E_HESLO = "e2e-test-heslo"; // musí sa zhodovať s hodnotou v login.spec.ts

const { db, pool } = createDb();
// Konštantný literál bez interpolácie — obyčajný reťazec je tu rovnako bezpečný
// ako `sql` tagovaná šablóna (tú používa ekvivalentný apps/api/tests/helpers/db.ts),
// ale vyhne sa priamemu importu z "drizzle-orm" v tomto samostatnom skripte mimo
// TS projektu apps/api — ESLint-ova type-aware kontrola vtedy nevie spoľahlivo
// odvodiť typ tagovanej šablóny a hlási falošné @typescript-eslint/no-unsafe-*.
await db.execute(
  "TRUNCATE TABLE ingest_issue, variant, product, catalog_snapshot, job_run, audit_events, sessions, users RESTART IDENTITY CASCADE",
);
await db.insert(users).values({
  email: "e2e@forestshop.sk",
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});

// Katalóg pre E2E: tá istá commitnutá fixtúra ako v jednotkových testoch, cez tú istú
// službu importu — E2E tak overuje skutočnú cestu dát, nie ručne nasypané riadky.
// Limity sú uvoľnené, lebo fixtúra má 35 riadkov (produkčná hranica je 1 000).
const fixture = readFileSync(
  fileURLToPath(new URL("../apps/api/src/modules/catalog/fixtures/shoptet-sample.csv", import.meta.url)),
);
const vysledok = await ingestCatalog(db, {
  fetchExport: () => Promise.resolve({ body: fixture, sourceLabel: "E2E fixtúra" }),
  now: new Date(),
  rawDir: fileURLToPath(new URL("../data/e2e-catalog-raw", import.meta.url)),
  limits: { ...DEFAULT_SNAPSHOT_LIMITS, minByteSize: 1_000, absoluteMinRows: 10 },
});
if (vysledok.status !== "accepted") {
  throw new Error(`E2E fixtúra nebola prijatá: ${JSON.stringify(vysledok)}`);
}

// Presne jeden variant sa priamo (mimo `ingestCatalog`) označí ako chýbajúci —
// E2E tak overí aj čítaciu cestu chýbajúceho variantu (review final-wave-a,
// položka 6), nielen prípad "všetko je aktuálne". "40287" je jednovariantný
// produkt so stavom "sellable" (map-row.test.ts) — filter podľa "sellable"
// tak zostáva 6 aj s ním, presne ako pred touto zmenou. Konštantný literál bez
// interpolácie (rovnaký dôvod ako TRUNCATE vyššie — priamy import z
// "drizzle-orm", vrátane `eq`/query buildera, hlási v tomto samostatnom
// skripte mimo TS projektu apps/api falošné @typescript-eslint/no-unsafe-*),
// bezpečný presne preto, že reťazec nikdy nenesie vonkajší vstup.
await db.execute("UPDATE variant SET missing_since = now() WHERE code = '40287'");

await pool.end();
