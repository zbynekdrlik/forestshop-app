// Pripraví databázu pre E2E beh: vymaže všetky riadky a založí testovacích
// používateľov. Beží pred štartom API servera (viď
// apps/web/playwright.config.ts) a je idempotentný — opakované spustenie
// necháva rovnaký počet používateľov vďaka TRUNCATE pred insertom.
//
// POZOR: mieri na tú istú lokálnu databázu ako integračné testy (DATABASE_URL
// z prostredia). To je v poriadku LEN preto, že tabuľky vždy najprv vyprázdni
// — nikdy nesmerovať na databázu, ktorá obsahuje reálne dáta.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb } from "../apps/api/src/db/client.js";
import { orderLines, orders, pairings, users } from "../apps/api/src/db/schema.js";
import { hashPassword } from "../apps/api/src/modules/auth/passwords.js";
import { ingestCatalog } from "../apps/api/src/modules/catalog/ingest.js";
import { DEFAULT_SNAPSHOT_LIMITS } from "../apps/api/src/modules/catalog/validation.js";

const E2E_HESLO = "e2e-test-heslo"; // musí sa zhodovať s hodnotou v login.spec.ts/catalog.spec.ts/orders.spec.ts

// #32: vlastný, IZOLOVANÝ účet len pre `login.spec.ts`'s test zmeny hesla.
// Ten test DOČASNE mení SKUTOČNÉ heslo prihláseného účtu v DB (staré → nové →
// späť) — keby sa prihlasoval pod ZDIEĽANÝM `e2e@forestshop.sk` (ako
// `catalog.spec.ts`/`orders.spec.ts`/zvyšné testy v `login.spec.ts`), Playwright
// pri `--workers=2` (CI default) plánuje spec SÚBORY na súbežné workery proti
// JEDNÉMU zdieľanému API serveru + JEDNEJ DB — súbežný `POST /api/login` z INÉHO
// súboru, spadnutý presne do okna medzi zmenou a vrátením hesla, by dostal
// skutočný 401 (heslo v DB v tej chvíli nesedí s naprogramovaným literálom).
// Reprodukované a potvrdené #32 (5× `--workers=2`, 4× zlyhalo presne takto —
// pozri komentár na tickete pred touto zmenou). Účet tu nižšie zostáva jediný,
// ktorého heslo sa kedy mení — nikto iný sa pod ním neprihlasuje.
const E2E_HESLO_ZMENA_EMAIL = "e2e-heslo@forestshop.sk"; // musí sa zhodovať s hodnotou v login.spec.ts

// Issue 47 (F4 rozdelenie podľa veľkostí) — VLASTNÝ, IZOLOVANÝ účet pre
// `pairing.spec.ts`'s test skupinového (bulk) párovania. Dôvod je INÝ ako pri
// `E2E_HESLO_ZMENA_EMAIL` vyššie (tam ide o súbežnú MUTÁCIU hesla), ale
// rovnaký mechanizmus rieši aj tento: `checkLoginRateLimit`
// (`apps/api/src/http/login-rate-limit.ts`) počíta KAŽDÝ `POST /api/login`
// (úspešný aj neúspešný) proti dvojici (IP, e-mail), max. 10 v 5-minútovom
// okne — a CELÝ e2e beh zdieľa JEDEN dlho bežiaci API server proces. Nový
// test (9 veľkostí naraz) pridal 3. prihlásenie pod `e2e@forestshop.sk` v
// `pairing.spec.ts` a spolu so zvyškom balíka (catalog+login+orders+pairing)
// to prekročilo 10 prihlásení pod TOU ISTOU dvojicou (IP, e-mail) — reálne
// pozorované zlyhanie "Nesprávny e-mail alebo heslo" pri `--workers=2`, nie
// flaka. Vlastný e-mail = vlastný rate-limit priestor, žiadny zásah do
// bezpečnostného limitu.
const E2E_SKUPINY_EMAIL = "e2e-skupiny@forestshop.sk"; // musí sa zhodovať s hodnotou v pairing.spec.ts

const { db, pool } = createDb();
// Konštantný literál bez interpolácie — obyčajný reťazec je tu rovnako bezpečný
// ako `sql` tagovaná šablóna (tú používa ekvivalentný apps/api/tests/helpers/db.ts),
// ale vyhne sa priamemu importu z "drizzle-orm" v tomto samostatnom skripte mimo
// TS projektu apps/api — ESLint-ova type-aware kontrola vtedy nevie spoľahlivo
// odvodiť typ tagovanej šablóny a hlási falošné @typescript-eslint/no-unsafe-*.
// `order_line, "order"` sú pridané RUČNE (`.claude/rules/testing.md` #20) —
// `TRUNCATE variant CASCADE` by síce strhol `order_line` (referencuje
// `variant.code`), ale NIE `order` (rodič `order_line`, cascade ide len jedným
// smerom) — bez ručného pridania by riadky `order` z predchádzajúceho E2E
// behu ticho prežívali. `"order"` je rezervované SQL kľúčové slovo, musí byť
// uvodzované ručne v priamom SQL stringu.
// "supplier_contact" (#31) pridané rovnakým dôvodom ako "order_line, \"order\""
// vyššie — nemá žiadny FK (kľúčovaný reťazcom dodávateľa, nie id), CASCADE ho
// preto nikdy nestrhne. "supplier" (#44) je rovnaký prípad — tiež kľúčovaný
// reťazcom mena dodávateľa, žiadny FK. "pairing" (#44) FK do "variant" má, takže
// by ho CASCADE strhol aj bez uvedenia — pridané ručne kvôli tej istej
// sebadokumentujúcej dôslednosti ako "order_line".
await db.execute(
  'TRUNCATE TABLE ingest_issue, variant, product, catalog_snapshot, job_run, audit_events, sessions, users, order_line, "order", supplier_contact, pairing, supplier RESTART IDENTITY CASCADE',
);
await db.insert(users).values({
  email: "e2e@forestshop.sk",
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
// Rovnaké počiatočné heslo a zobrazované meno ako vyššie (žiadny test naň
// nespolieha ako na odlišujúci znak) — jediný rozdiel je e-mail, ktorý ho robí
// SAMOSTATNÝM riadkom v `users`, izolovaným od zdieľaného účtu vyššie.
await db.insert(users).values({
  email: E2E_HESLO_ZMENA_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_SKUPINY_EMAIL,
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

// F3 (#24): dve otvorené objednávky nad UŽ naimportovanými fixtúrovými
// variantmi — žiadne ručné vkladanie produktu/variantu netreba, E2E tak
// overuje zoskupenie "Na objednanie" (#23) nad skutočne naimportovanými
// dátami. "4859/46" má v exporte reálneho dodávateľa ("DODAVATEL-TEST-1",
// map-row.test.ts), "40287" ho nemá (`product.supplier` je `null`) —
// zámerne pokrýva OBE vetvy zoskupenia podľa dodávateľa, vrátane zástupného
// kľúča "(bez dodávateľa)" (`modules/orders/queries.ts`).
const [objednavkaAlfa] = await db
  .insert(orders)
  .values({
    externalOrderId: "9001",
    customerName: "E2E Zákazník Alfa",
    comment: "Zavolať pred doručením",
    placedAt: new Date("2026-07-20T10:00:00Z"),
  })
  .returning();
if (objednavkaAlfa === undefined) throw new Error("E2E objednávka (dodávateľ) sa nepodarila vložiť");
await db.insert(orderLines).values({
  orderId: objednavkaAlfa.id,
  variantCode: "4859/46",
  quantity: 2,
  state: "caka_sa",
});

const [objednavkaBezDodavatela] = await db
  .insert(orders)
  .values({
    externalOrderId: "9002",
    customerName: "E2E Zákazník Bez dodávateľa",
    placedAt: new Date("2026-07-21T09:00:00Z"),
  })
  .returning();
if (objednavkaBezDodavatela === undefined) {
  throw new Error("E2E objednávka (bez dodávateľa) sa nepodarila vložiť");
}
await db.insert(orderLines).values({
  orderId: objednavkaBezDodavatela.id,
  variantCode: "40287",
  quantity: 1,
});

// F4 (#45): jeden UŽ NAVRHNUTÝ (nepotvrdený) pairing kandidát — simuluje to,
// čo by inak vložilo #46 (automatické hľadanie kandidátov, ešte
// neimplementované). Bez tohto by "pairing.spec.ts" nemalo ako otestovať
// "✓ Potvrdiť jedným klikom" cez skutočný prehliadač (žiadna appkina vlastná
// akcia dnes nevytvorí riadok v stave 'navrhnute' S vyplnenou adresou —
// ručné zadanie adresy cez UI rovno aj potvrdzuje, viď návrhový komentár na
// issue 45) — variant "4859/46" zostáva zámerne BEZ pairing riadku vôbec
// (LEFT JOIN prípad, otestovaný v prvom teste súboru).
await db.insert(pairings).values({
  variantCode: "40287",
  supplierUrl: "https://www.grube.sk/p/ciapka-polar-forest/1",
});

await pool.end();
