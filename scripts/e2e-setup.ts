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
import { jobRuns, mailLog, orderLines, orderOpenStatuses, orderReminderSettings, orders, pairings, postaUncollectedSettings, productSupplierLinkOverrides, products, shopProductUrl, supplierStock, users, variants } from "../apps/api/src/db/schema.js";
import { CATALOG_IMPORT_JOB_NAME } from "../apps/api/src/modules/scheduler/jobs.js";
import { hashPassword } from "../apps/api/src/modules/auth/passwords.js";
import { ingestCatalog } from "../apps/api/src/modules/catalog/ingest.js";
import { DEFAULT_SNAPSHOT_LIMITS } from "../apps/api/src/modules/catalog/validation.js";
import { DEFAULT_ORDER_OPEN_STATUS } from "../apps/api/src/modules/orders/open-statuses.js";
import { POSTA_UNCOLLECTED_SETTINGS_ID } from "../apps/api/src/modules/posta-uncollected/settings.js";
import { ORDER_REMINDER_SETTINGS_ID } from "../apps/api/src/modules/order-reminder/settings.js";
import { seedDpdFixtures } from "./e2e-fixtures-dpd.js";
import { seedFloorOrdersFixtures } from "./e2e-fixtures-floor-orders.js";
import { seedOrderFlagsFixtures } from "./e2e-fixtures-order-flags.js";
import { seedPaginationFixtures } from "./e2e-fixtures-pagination.js";
import { seedProductLinksFixtures } from "./e2e-fixtures-product-links.js";
import { seedRestockEventsFixtures } from "./e2e-fixtures-restock-events.js";
import { seedRestockLinksFixtures } from "./e2e-fixtures-restock-links.js";
import { seedSearchFixtures } from "./e2e-fixtures-search.js";

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

// Issue 57 (ľavé menu): rovnaký mechanizmus a dôvod ako `E2E_SKUPINY_EMAIL`
// vyššie — nový `nav.spec.ts` pridal ĎALŠIE 2 prihlásenia pod zdieľaným
// `e2e@forestshop.sk`, čo spolu so zvyškom balíka (catalog 3 + login 2 +
// orders 3 + pairing 2 = 10, presne na hranici `MAX_ATTEMPTS`) prekročilo
// limit 10 v 5-minútovom okne — reálne pozorované "Nesprávny e-mail alebo
// heslo" na náhodnom neskoršom teste (11./12. pokus tej istej dvojice IP+
// e-mail), nie flaka. Vlastný e-mail = vlastný rate-limit priestor.
const E2E_NAV_EMAIL = "e2e-nav@forestshop.sk"; // musí sa zhodovať s hodnotou v nav.spec.ts

// issue 59: rovnaký mechanizmus a dôvod ako `E2E_NAV_EMAIL`/`E2E_SKUPINY_EMAIL`
// vyššie — balík je UŽ na hranici `MAX_ATTEMPTS` (komentár vyššie), takže
// nový test (nastavenie otvorených stavov) dostáva VLASTNÝ izolovaný účet
// namiesto ďalšieho prihlásenia pod zdieľaným `e2e@forestshop.sk`.
const E2E_OTVORENE_STAVY_EMAIL = "e2e-otvorene-stavy@forestshop.sk"; // musí sa zhodovať s hodnotou v orders.spec.ts

// issue 60: rovnaký mechanizmus a dôvod ako `E2E_OTVORENE_STAVY_EMAIL`
// vyššie — balík je UŽ na hranici `MAX_ATTEMPTS` (komentár vyššie), takže
// nový test (odškrtávacie políčko + hromadné označenie skupiny) dostáva
// VLASTNÝ izolovaný účet namiesto ďalšieho prihlásenia pod zdieľaným
// `e2e@forestshop.sk`.
const E2E_OBJEDNANE_EMAIL = "e2e-objednane@forestshop.sk"; // musí sa zhodovať s hodnotou v orders.spec.ts

// issue 61: VLASTNÝ izolovaný účet — rovnaký mechanizmus a dôvod ako vyššie
// (balík je už na hranici `MAX_ATTEMPTS`). Test pod týmto účtom je zámerne
// PRVÝ v `orders.spec.ts` (nie posledný ako ostatné nové testy vyššie) —
// overuje PÔVODNÉ, ešte-nezmenené seedované dáta (DODAVATEL-TEST-1 v
// "caka_sa", "(bez dodávateľa)" v predvolenom "objednane"), kým ich testy
// NIŽŠIE v súbore (zmena stavu/objednané, pridanie stavu do nastavenia)
// ešte nestihli zmutovať — poradie testov v súbore je tu preto zámerne
// dôležité, nie náhodné.
const E2E_FILTRE_EMAIL = "e2e-filtre@forestshop.sk"; // musí sa zhodovať s hodnotou v orders.spec.ts

// issue 62: rovnaký mechanizmus a dôvod ako `E2E_OTVORENE_STAVY_EMAIL`/
// `E2E_OBJEDNANE_EMAIL` vyššie — balík je UŽ na hranici `MAX_ATTEMPTS`
// (10, komentár vyššie pri `E2E_NAV_EMAIL`), takže nový test (súčet kusov
// toho istého produktu naprieč objednávkami dodávateľa) dostáva VLASTNÝ
// izolovaný účet namiesto ďalšieho prihlásenia pod zdieľaným
// `e2e@forestshop.sk`.
const E2E_SUCET_EMAIL = "e2e-sucet@forestshop.sk"; // musí sa zhodovať s hodnotou v orders.spec.ts

// issue 63: rovnaký mechanizmus a dôvod ako `E2E_SUCET_EMAIL` vyššie — VLASTNÝ
// izolovaný účet pre `orders-supplier-assign.spec.ts` (nový SAMOSTATNÝ súbor,
// nie ďalší test v `orders.spec.ts`, ktorý je už na hranici eslint
// `max-lines`, `.claude/rules/testing.md`).
const E2E_PRIRADENIE_EMAIL = "e2e-priradenie@forestshop.sk"; // musí sa zhodovať s hodnotou v orders-supplier-assign.spec.ts

// issue 64: rovnaký mechanizmus a dôvod ako `E2E_PRIRADENIE_EMAIL` vyššie —
// zdieľaný `e2e@forestshop.sk` je PRESNE na hranici `MAX_ATTEMPTS` (10
// prihlásení naprieč `catalog.spec.ts`(3)+`login.spec.ts`(2)+
// `orders.spec.ts`(3)+`pairing.spec.ts`(2), overené naživo počítaním pred
// touto zmenou) — nový test (poznámka k objednávke) dostáva VLASTNÝ
// izolovaný účet namiesto ďalšieho prihlásenia pod zdieľaným.
const E2E_KOMENTAR_EMAIL = "e2e-komentar@forestshop.sk"; // musí sa zhodovať s hodnotou v orders.spec.ts

// issue 107: rovnaký mechanizmus a dôvod ako `E2E_KOMENTAR_EMAIL` vyššie —
// balík je UŽ na hranici `MAX_ATTEMPTS` (10), takže nový spec súbor
// (`orders-layout.spec.ts` — vizuálna regresia STAV/POZNÁMKY/DODÁVATEĽ)
// dostáva VLASTNÝ izolovaný účet namiesto ďalšieho prihlásenia pod
// zdieľaným `e2e@forestshop.sk`.
const E2E_ROZLOZENIE_EMAIL = "e2e-rozlozenie@forestshop.sk"; // musí sa zhodovať s hodnotou v orders-layout.spec.ts

// issue 121: rovnaký mechanizmus a dôvod ako `E2E_ROZLOZENIE_EMAIL` vyššie —
// balík je UŽ na hranici `MAX_ATTEMPTS` (10), takže nový test (manuálny
// odkaz na dodávateľa — doplniť/upraviť) dostáva VLASTNÝ izolovaný účet
// namiesto ďalšieho prihlásenia pod zdieľaným `e2e@forestshop.sk`.
const E2E_ODKAZ_EMAIL = "e2e-odkaz@forestshop.sk"; // musí sa zhodovať s hodnotou v orders.spec.ts

// issue 66: rovnaký mechanizmus a dôvod ako `E2E_ODKAZ_EMAIL` vyššie — balík
// je UŽ na hranici `MAX_ATTEMPTS` (10), takže nový spec súbor (`orders-
// write-failures.spec.ts` — kumulatívny banner o neuložených zmenách)
// dostáva VLASTNÝ izolovaný účet namiesto ďalšieho prihlásenia pod
// zdieľaným `e2e@forestshop.sk`.
const E2E_ZAPISY_EMAIL = "e2e-zapisy@forestshop.sk"; // musí sa zhodovať s hodnotou v orders-write-failures.spec.ts

// issue 149: rovnaký mechanizmus a dôvod ako `E2E_ZAPISY_EMAIL` vyššie —
// nový spec súbor (`orders-hidden-editor.spec.ts` — riadok s otvoreným
// editorom nesmie zmiznúť pri "skryť vybavené") dostáva VLASTNÝ izolovaný
// účet namiesto ďalšieho prihlásenia pod zdieľaným `e2e@forestshop.sk`.
const E2E_SKRYTY_EDITOR_EMAIL = "e2e-skryty-editor@forestshop.sk"; // musí sa zhodovať s hodnotou v orders-hidden-editor.spec.ts

// issue 172: rovnaký mechanizmus a dôvod ako `E2E_SKRYTY_EDITOR_EMAIL`
// vyššie — zdieľaný balík (`e2e@forestshop.sk`, reálne prihlásenia spočítané
// naprieč všetkými spec súbormi) je UŽ na hranici `MAX_ATTEMPTS` (10, komentár
// vyššie pri `E2E_NAV_EMAIL`), takže nový spec súbor (`posta-uncollected.spec.ts`)
// dostáva VLASTNÝ izolovaný účet namiesto ďalšieho prihlásenia pod zdieľaným.
const E2E_POSTA_EMAIL = "e2e-posta@forestshop.sk"; // musí sa zhodovať s hodnotou v posta-uncollected.spec.ts

// issue 173: rovnaký mechanizmus a dôvod ako `E2E_POSTA_EMAIL` vyššie —
// nový spec súbor (`order-reminder.spec.ts`) dostáva VLASTNÝ izolovaný účet
// namiesto ďalšieho prihlásenia pod zdieľaným `e2e@forestshop.sk`.
const E2E_PRIPOMIENKY_EMAIL = "e2e-pripomienky@forestshop.sk"; // musí sa zhodovať s hodnotou v order-reminder.spec.ts

// issue 176: rovnaký mechanizmus a dôvod ako `E2E_PRIPOMIENKY_EMAIL` vyššie —
// nový spec súbor (`nedostupne.spec.ts`) dostáva VLASTNÝ izolovaný účet
// namiesto ďalšieho prihlásenia pod zdieľaným `e2e@forestshop.sk`.
const E2E_NEDOSTUPNE_EMAIL = "e2e-nedostupne@forestshop.sk"; // musí sa zhodovať s hodnotou v nedostupne.spec.ts

// issue 192: rovnaký mechanizmus a dôvod ako `E2E_NEDOSTUPNE_EMAIL` vyššie —
// nový spec súbor (`mail-templates.spec.ts`) dostáva VLASTNÝ izolovaný účet
// namiesto ďalšieho prihlásenia pod zdieľaným `e2e@forestshop.sk`.
const E2E_MAILY_EMAIL = "e2e-maily@forestshop.sk"; // musí sa zhodovať s hodnotou v mail-templates.spec.ts

// issue 193: rovnaký mechanizmus a dôvod ako `E2E_MAILY_EMAIL` vyššie — nový
// spec súbor (`mail-log.spec.ts`) dostáva VLASTNÝ izolovaný účet.
const E2E_KNIHA_EMAIL = "e2e-kniha@forestshop.sk"; // musí sa zhodovať s hodnotou v mail-log.spec.ts

// issue 217: rovnaký mechanizmus a dôvod ako `E2E_KNIHA_EMAIL` vyššie — nový
// spec súbor (`restock-waiting.spec.ts`) dostáva VLASTNÝ izolovaný účet.
const E2E_PREPINANIE_EMAIL = "e2e-prepinanie@forestshop.sk"; // musí sa zhodovať s hodnotou v restock-waiting.spec.ts

// issue 237: rovnaký mechanizmus a dôvod ako `E2E_PREPINANIE_EMAIL` vyššie —
// nový spec súbor (`orders-overview.spec.ts` — blok dlaždíc "Prehľad
// e-shopu"/"Súhrn o objednávaní") dostáva VLASTNÝ izolovaný účet.
const E2E_PREHLAD_EMAIL = "e2e-prehlad@forestshop.sk"; // musí sa zhodovať s hodnotou v orders-overview.spec.ts

// issue 227: rovnaký mechanizmus a dôvod ako `E2E_PREPINANIE_EMAIL` vyššie —
// nový spec súbor (`supplier-stock.spec.ts` — prehľad podľa domény + vlastný
// e-shop) dostáva VLASTNÝ izolovaný účet.
const E2E_DOMENY_EMAIL = "e2e-domeny@forestshop.sk"; // musí sa zhodovať s hodnotou v supplier-stock.spec.ts

// issue 254: rovnaký mechanizmus a dôvod ako `E2E_DOMENY_EMAIL` vyššie —
// nové race-testy (stale-closure refetch/search race + cross-row editor-close
// guard) v `pairing.spec.ts`/`catalog.spec.ts` dostávajú VLASTNÝ izolovaný účet
// namiesto ďalšieho prihlásenia pod zdieľaným `e2e@forestshop.sk` (balík je
// UŽ na hranici `MAX_ATTEMPTS`, komentár vyššie pri `E2E_NAV_EMAIL`). Rola
// "manazer" pokrýva `CAN_CONFIRM_ROLES` (párovanie) aj `IMPORT_ROLES`
// (katalóg) — jeden účet stačí pre testy v OBOCH spec súboroch.
const E2E_RACE_EMAIL = "e2e-race@forestshop.sk"; // musí sa zhodovať s hodnotou v pairing.spec.ts/catalog.spec.ts

// issue 257: rovnaký mechanizmus a dôvod ako `E2E_RACE_EMAIL` vyššie — nový
// spec súbor (`order-merge.spec.ts` — "Zlúčenie objednávok") dostáva VLASTNÝ
// izolovaný účet namiesto ďalšieho prihlásenia pod zdieľaným
// `e2e@forestshop.sk` (balík je už na hranici `MAX_ATTEMPTS`, komentár
// vyššie pri `E2E_NAV_EMAIL`). Rola "manazer" — táto obrazovka vyžaduje
// `admin`/`manazer` na odoslanie, rovnaká úroveň ako "Nedostupné tovary".
const E2E_ZLUCENIE_EMAIL = "e2e-zlucenie@forestshop.sk"; // musí sa zhodovať s hodnotou v order-merge.spec.ts

// issue 264: rovnaký mechanizmus a dôvod ako `E2E_ZLUCENIE_EMAIL` vyššie —
// nový spec súbor (`theme-colors.spec.ts` — koliesko "Farby aplikácie")
// dostáva VLASTNÝ izolovaný účet. Rola "manazer" — zápis vyžaduje
// `admin`/`manazer`.
const E2E_FARBY_EMAIL = "e2e-farby@forestshop.sk"; // musí sa zhodovať s hodnotou v theme-colors.spec.ts

// issue 267: rovnaký mechanizmus a dôvod ako `E2E_FARBY_EMAIL` vyššie — nový
// spec súbor (`upozornenia.spec.ts` — nástenka "Upozornenia") dostáva
// VLASTNÝ izolovaný účet. Rola "manazer" — zápis/vybavenie vyžaduje
// `admin`/`manazer`.
const E2E_UPOZORNENIA_EMAIL = "e2e-upozornenia@forestshop.sk"; // musí sa zhodovať s hodnotou v upozornenia.spec.ts

// issue 291: rovnaký mechanizmus a dôvod ako `E2E_UPOZORNENIA_EMAIL` vyššie —
// nový spec súbor (`mobile-responsive.spec.ts` — kontrola vodorovného
// posúvania stránky na telefónnej šírke) dostáva VLASTNÝ izolovaný účet.
const E2E_MOBIL_EMAIL = "e2e-mobil@forestshop.sk"; // musí sa zhodovať s hodnotou v mobile-responsive.spec.ts

// issue 342: rovnaký mechanizmus a dôvod ako `E2E_MOBIL_EMAIL` vyššie — nový
// spec súbor (`daily-tasks.spec.ts` — "Dôležité → Úlohy na dnes") dostáva
// VLASTNÝ izolovaný účet. Rola "citanie" (zámerne — `daily-tasks-routes.ts`
// nevyžaduje admin/manazer, úlohy sú súkromné pre KAŽDÚ rolu, test to overuje).
const E2E_ULOHY_EMAIL = "e2e-ulohy@forestshop.sk"; // musí sa zhodovať s hodnotou v daily-tasks.spec.ts

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
// "order_open_status" (issue 59) je rovnaký prípad ako "supplier_contact"/
// "supplier" vyššie v komentári tesne pod TRUNCATE — kľúčovaný voľným
// textom stavu, žiadny FK, CASCADE ho nikdy nestrhne. "posta_uncollected_
// settings"/"posta_uncollected_state" (issue 172) sú rovnaký prípad —
// singleton id / kód objednávky, žiadny FK. "order_reminder_settings"/
// "order_reminder_state" (issue 173) sú rovnaký prípad znova.
await db.execute(
  // "supplier_stock"/"restock_settings"/"restock_event" (issue 217) sú znova ten
  // istý prípad — kľúčované odkazom / singleton id, žiadny FK do `variant`,
  // takže CASCADE ich nikdy nestrhne. Bez nich by potvrdenia dodávateľa z
  // PREDOŠLÉHO e2e behu prežili do ďalšieho (presne past popísaná v
  // `.claude/rules/supplier-stock.md`, tam pre `tests/helpers/db.ts`).
  // "dpd_pickup_request" (issue 292) je rovnaký prípad znova — bez FK,
  // pridané ručne (`tests/helpers/db.ts` má rovnaký riadok navyše).
  // "dpd_shipment" NETREBA — FK do "order" ho CASCADE strhne automaticky.
  'TRUNCATE TABLE ingest_issue, variant, product, catalog_snapshot, job_run, audit_events, sessions, users, order_line, "order", supplier_contact, pairing, supplier, order_open_status, posta_uncollected_settings, posta_uncollected_state, order_reminder_settings, order_reminder_state, nedostupne_state, nedostupne_replacement_link, mail_template, mail_template_history, supplier_stock, restock_settings, restock_event, shop_product_url, theme_color, dpd_pickup_request RESTART IDENTITY CASCADE',
);
// Rovnaký dôvod ako `tests/helpers/db.ts`: bez tohto by "Na objednanie" bolo
// v CELOM e2e behu prázdne pre KAŽDÚ objednávku (žiadny nastavený otvorený
// stav). Reseeduje presne to, čo produkčná migrácia zapíše na čerstvej DB.
await db.insert(orderOpenStatuses).values({ statusName: DEFAULT_ORDER_OPEN_STATUS });
// issue 172: rovnaký dôvod — migrácia seeduje `posta_uncollected_settings`'s
// singleton riadok (`enabled=false`), reseedovať ho treba aj tu.
await db.insert(postaUncollectedSettings).values({ id: POSTA_UNCOLLECTED_SETTINGS_ID, enabled: false });
// issue 173: rovnaký dôvod — migrácia seeduje `order_reminder_settings`'s
// singleton riadok (`enabled=false`), reseedovať ho treba aj tu.
await db.insert(orderReminderSettings).values({ id: ORDER_REMINDER_SETTINGS_ID, enabled: false });
await db.insert(users).values({ email: "e2e@forestshop.sk", passwordHash: await hashPassword(E2E_HESLO), displayName: "E2E Manažér", role: "manazer" });
// Rovnaké počiatočné heslo a zobrazované meno ako vyššie (žiadny test naň
// nespolieha ako na odlišujúci znak) — jediný rozdiel je e-mail, ktorý ho robí
// SAMOSTATNÝM riadkom v `users`, izolovaným od zdieľaného účtu vyššie.
await db.insert(users).values({ email: E2E_HESLO_ZMENA_EMAIL, passwordHash: await hashPassword(E2E_HESLO), displayName: "E2E Manažér", role: "manazer" });
await db.insert(users).values({ email: E2E_SKUPINY_EMAIL, passwordHash: await hashPassword(E2E_HESLO), displayName: "E2E Manažér", role: "manazer" });
await db.insert(users).values({ email: E2E_NAV_EMAIL, passwordHash: await hashPassword(E2E_HESLO), displayName: "E2E Manažér", role: "manazer" });
await db.insert(users).values({
  email: E2E_OTVORENE_STAVY_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_OBJEDNANE_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_FILTRE_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_SUCET_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_PRIRADENIE_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_KOMENTAR_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_ROZLOZENIE_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_ODKAZ_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_ZAPISY_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_SKRYTY_EDITOR_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_POSTA_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_PRIPOMIENKY_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_NEDOSTUPNE_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_MAILY_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_KNIHA_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_PREPINANIE_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_PREHLAD_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
await db.insert(users).values({
  email: E2E_DOMENY_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Čítanie",
  role: "citanie",
});
await db.insert(users).values({ email: E2E_RACE_EMAIL, passwordHash: await hashPassword(E2E_HESLO), displayName: "E2E Manažér", role: "manazer" });
await db.insert(users).values({ email: E2E_ZLUCENIE_EMAIL, passwordHash: await hashPassword(E2E_HESLO), displayName: "E2E Manažér", role: "manazer" });
await db.insert(users).values({ email: E2E_FARBY_EMAIL, passwordHash: await hashPassword(E2E_HESLO), displayName: "E2E Manažér", role: "manazer" });
await db.insert(users).values({ email: E2E_UPOZORNENIA_EMAIL, passwordHash: await hashPassword(E2E_HESLO), displayName: "E2E Manažér", role: "manazer" });
await db.insert(users).values({ email: E2E_MOBIL_EMAIL, passwordHash: await hashPassword(E2E_HESLO), displayName: "E2E Manažér", role: "manazer" });
await db.insert(users).values({ email: E2E_ULOHY_EMAIL, passwordHash: await hashPassword(E2E_HESLO), displayName: "E2E Čitateľ", role: "citanie" });

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
// issue 59: `statusName` explicitne na predvolený otvorený stav — nie
// preto, že by inak neplatilo (DB `default` na stĺpci je tá istá hodnota),
// ale aby to bolo tu VIDIEŤ, prečo tieto objednávky vôbec zostávajú v
// zozname "Na objednanie" po pridaní filtra podľa stavu.
const [objednavkaAlfa] = await db
  .insert(orders)
  .values({
    externalOrderId: "9001",
    customerName: "E2E Zákazník Alfa",
    comment: "Zavolať pred doručením",
    // issue 65: zákaznícky odkaz (`remark` — NIE `shopRemark`,
    // `.claude/rules/orders.md`) — nezávislé pole od manažérovho `comment`
    // vyššie, appka ho zobrazuje LEN na čítanie.
    remark: "Prosím doručiť len v piatok",
    // issue 164: SUROVÁ hodnota internej poznámky e-shopu — appka na čítacej
    // strane (`extractForeignShopRemark`) vráti tento text nezmenený, keďže
    // neobsahuje náš vlastný blok (`note-block.ts`'s oddeľovače).
    shopRemark: "Sklad potvrdil, pripravené na vyzdvihnutie",
    statusName: DEFAULT_ORDER_OPEN_STATUS,
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
    statusName: DEFAULT_ORDER_OPEN_STATUS,
    // issue 65: zámerne HLBOKO v minulosti (nie len "pred pár dňami") —
    // objednávka 9002 zostáva vo VÝCHODISKOVOM ("objednane"/nevybavenom)
    // stave počas CELÉHO e2e behu (žiadny test v `orders.spec.ts` ju
    // nemení), takže je bezpečný, stále platný kandidát na test upozornenia
    // na staré objednávky (⚠️, `ordersSummary.ts`'s `isStaleOrderLine`) —
    // pevný dátum v minulosti zostáva "starý" navždy, bez ohľadu na to,
    // kedy CI beh skutočne prebehne.
    placedAt: new Date("2020-01-01T09:00:00Z"),
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

// issue 59: TRETIA objednávka, zámerne v stave MIMO predvoleného otvoreného
// zoznamu ("E2E-Uzavreta" — vymyslený, testovo-vyhradený literál, nikdy
// nekolidujúci so skutočným Shoptet stavom) — `orders.spec.ts` ňou dokazuje,
// že (a) sa NEUKÁŽE, kým nie je jej stav v nastavenom zozname, a (b) po
// pridaní stavu cez nastavenie priamo v UI sa objaví, bez reloadu. Pridáva
// sa (nikdy nenahrádza) do zdieľaného zoznamu — bezpečné voči súbežne
// bežiacim iným e2e spec súborom presne z rovnakého dôvodu ako
// `frontend-design.md`'s zdieľaný `e2e@forestshop.sk` účet.
const [objednavkaUzavreta] = await db
  .insert(orders)
  .values({
    externalOrderId: "9003",
    customerName: "E2E Zákazník Uzavretá",
    statusName: "E2E-Uzavreta",
    placedAt: new Date("2026-07-22T09:00:00Z"),
  })
  .returning();
if (objednavkaUzavreta === undefined) throw new Error("E2E objednávka (uzavretá) sa nepodarila vložiť");
await db.insert(orderLines).values({
  orderId: objednavkaUzavreta.id,
  variantCode: "40287",
  quantity: 3,
  // `state: "skladom"` (NIE predvolené "objednane") — `mail.ts`'s
  // `loadOutstandingLines` agreguje LEN riadky v stave "objednane" naprieč
  // VŠETKÝMI objednávkami toho istého dodávateľa, bez ohľadu na
  // `order.status_name` (mail agregácia a Shoptet-ov stav objednávky sú
  // zámerne nezávislé, viď `.claude/rules/orders.md`). Default "objednane"
  // by preto TÚTO objednávku prisčítal do "(bez dodávateľa)" mailového
  // náhľadu (1 ks → 4 ks) a rozbil `orders.spec.ts`'s existujúci mailový
  // test, hoci s "Na objednanie" zoznamom (predmet TOHTO ticketu) to
  // nemá nič spoločné.
  state: "skladom",
});

// Issue 62: DVE ĎALŠIE objednávky od DVOCH rôznych zákazníkov nad TÝM ISTÝM
// variantom ("60055/10", supplier v CSV fixtúre nastavený na nový, dovtedy
// nepoužitý "DODAVATEL-TEST-2" — `apps/api/src/modules/catalog/fixtures/
// shoptet-sample.csv`) — zámerne NOVÝ dodávateľ, nie DODAVATEL-TEST-1 ani
// "(bez dodávateľa)", ktorých presné počty riadkov iné testy v
// `orders.spec.ts` overujú ("Všetci (2)" a pod. — pridanie riadku do
// existujúcej skupiny by ich tichým spôsobom rozbilo). Obe objednávky
// zostávajú vo VÝCHODISKOVOM stave ("objednane"/nevybavené) — súčet
// "Σ spolu" (issue 62) tak pri prvom vykreslení ukazuje CELÉ dopytované
// množstvo ako zostávajúce (3 + 2 = 5 ks), presne to, čo e2e test tohto
// ticketu overuje pred aj po prepnutí stavu jedného z riadkov.
const [objednavkaSucetPrva] = await db.insert(orders).values({ externalOrderId: "9004", customerName: "E2E Zákazník Súčet Prvá", statusName: DEFAULT_ORDER_OPEN_STATUS, placedAt: new Date("2026-07-23T09:00:00Z") }).returning();
if (objednavkaSucetPrva === undefined) throw new Error("E2E objednávka (súčet, prvá) sa nepodarila vložiť");
await db.insert(orderLines).values({ orderId: objednavkaSucetPrva.id, variantCode: "60055/10", quantity: 3 });

const [objednavkaSucetDruha] = await db.insert(orders).values({ externalOrderId: "9005", customerName: "E2E Zákazník Súčet Druhá", statusName: DEFAULT_ORDER_OPEN_STATUS, placedAt: new Date("2026-07-24T09:00:00Z") }).returning();
if (objednavkaSucetDruha === undefined) throw new Error("E2E objednávka (súčet, druhá) sa nepodarila vložiť");
await db.insert(orderLines).values({ orderId: objednavkaSucetDruha.id, variantCode: "60055/10", quantity: 2 });

// issue 257: DVE otvorené objednávky TOHO ISTÉHO (fiktívneho) zákazníka —
// presne jeden kandidát na zlúčenie, ktorý nová záložka "Zlúčenie
// objednávok" má vypísať. `listMergeCandidateGroups` (`orders/merge-mail.ts`)
// číta VÝHRADNE tabuľku `orders` (customerIdentityKey podľa e-mailu), takže
// tieto dve objednávky ZÁMERNE nemajú ŽIADEN `order_line` riadok — nulový
// dopad na presné počty riadkov/dodávateľských skupín, ktoré iné testy v
// `orders.spec.ts` overujú (`.claude/rules/testing.md`'s "nový fixtúrový
// variant sa nesmie vybrať len podľa 'je nepoužitý'" poučenie sa tu netýka,
// lebo žiadny variant sa vôbec nepoužíva).
// Žiadne `.returning()`/id netreba — nič ďalšie v tomto skripte sa naň
// neodkazuje (na rozdiel od objednávok vyššie, ktoré potrebujú vlastný `id`
// pre `order_line`).
await db
  .insert(orders)
  .values({ externalOrderId: "9010", customerName: "E2E Zákazník Zlúčenie", email: "e2e-zakaznik-zlucenie@example.sk", statusName: DEFAULT_ORDER_OPEN_STATUS, placedAt: new Date("2026-07-25T09:00:00Z") });
await db
  .insert(orders)
  .values({ externalOrderId: "9011", customerName: "E2E Zákazník Zlúčenie", email: "e2e-zakaznik-zlucenie@example.sk", statusName: DEFAULT_ORDER_OPEN_STATUS, placedAt: new Date("2026-07-26T09:00:00Z") });

// issue 63: DVE riadky BEZ dodávateľa nad DVOMA veľkosťami TOHO ISTÉHO
// produktu ("60035/L", "60035/M" — CSV fixtúra ich nesie s prázdnym
// `supplier`, dovtedy nepoužité v žiadnom teste, `.claude/rules/catalog.md`'s
// CSV-editačný vzor) — NIE "40287" (ten `orders.spec.ts` viacnásobne overuje
// presným počtom/obsahom "(bez dodávateľa)" skupiny; tento test by ho
// manuálnym priradením natrvalo presunul preč a rozbil tie testy). DVE
// veľkosti toho istého produktu overujú "platí aj pre ĎALŠIU veľkosť"
// (ticket bod 2) — obe štartujú BEZ dodávateľa, priradenie cez JEDNU musí
// platiť aj pre druhú. Pridáva GLOBÁLNE 2 riadky do "(bez dodávateľa)" —
// `orders.spec.ts`'s prvý test (E2E_FILTRE_EMAIL) preto počíta so "Všetci
// (6)"/"(bez dodávateľa) (3)" namiesto pôvodných (4)/(1).
const [objednavkaPriradenie] = await db
  .insert(orders)
  .values({
    externalOrderId: "9006",
    customerName: "E2E Zákazník Priradenie",
    statusName: DEFAULT_ORDER_OPEN_STATUS,
    placedAt: new Date("2026-07-25T09:00:00Z"),
  })
  .returning();
if (objednavkaPriradenie === undefined) throw new Error("E2E objednávka (priradenie) sa nepodarila vložiť");
await db.insert(orderLines).values([
  { orderId: objednavkaPriradenie.id, variantCode: "60035/L", quantity: 1 },
  { orderId: objednavkaPriradenie.id, variantCode: "60035/M", quantity: 1 },
]);

// issue 121: JEDEN riadok nad DOVTEDY NEPOUŽITÝM jednovariantným produktom
// ("278" — CSV fixtúra ho nesie s prázdnym `supplier`/`internalNote`,
// `.claude/rules/catalog.md`'s CSV-editačný vzor) — NIE "40287"/"60035/*"
// (tie `orders.spec.ts` viacnásobne overuje presným počtom/obsahom skupiny,
// a "4859/*" (jediný fixtúrový produkt so SKUTOČNÝM `internalNote` odkazom)
// by prepísanie odkazu na JEDNEJ veľkosti prejavilo aj na "4859/46",
// KTORÉHO presnú `href` hodnotu prvý test súboru hard-coduje — issue 67).
// Pridáva GLOBÁLNE 1 riadok do "(bez dodávateľa)" — `orders.spec.ts`'s prvý
// test (E2E_FILTRE_EMAIL) preto počíta so "Všetci (7)"/"(bez dodávateľa) (4)"
// namiesto predošlých (6)/(3).
const [objednavkaOdkaz] = await db
  .insert(orders)
  .values({
    externalOrderId: "9007",
    customerName: "E2E Zákazník Odkaz",
    statusName: DEFAULT_ORDER_OPEN_STATUS,
    placedAt: new Date("2026-07-26T09:00:00Z"),
  })
  .returning();
if (objednavkaOdkaz === undefined) throw new Error("E2E objednávka (odkaz) sa nepodarila vložiť");
await db.insert(orderLines).values({ orderId: objednavkaOdkaz.id, variantCode: "278", quantity: 1 });

// issue 176: JEDNA objednávka s riadkom v stave 'nedostupne' — variant
// "40287" (rovnaký variant ako 9002/9003), takže "Nedostupné tovary"
// (`nedostupne.spec.ts`) má naživo čo zobraziť. Pridáva GLOBÁLNE 1 riadok do
// "Na objednanie" (`orders.spec.ts`'s prvý test preto počíta so "Všetci (8)"/
// "(bez dodávateľa) (5)" a s "Nedostupné 1" v súhrne — "40287" nemá
// dodávateľa, rovnaký zámer ako 9002/9003).
// AKTUALIZÁCIA (issue 238, 2026-08-04): automatický `relatedProduct` návrh
// (`product.relatedCodes`, katalógová fixtúra ho stále nesie ako "60297",
// appka ho už NEČÍTA) je nahradený majiteľovými RUČNÝMI odkazmi
// (`nedostupne_replacement_link`, pridané cez UI priamo v e2e teste) —
// nižšie pribúda `shop_product_url` (preklik na náš e-shop) a RUČNÝ
// `product_supplier_link_override` (preklik na dodávateľa — fixtúra má pre
// tento variant PRÁZDNy `internalNote`, overené priamo na CSV).
const [objednavkaNedostupne] = await db
  .insert(orders)
  .values({
    externalOrderId: "9008",
    customerName: "E2E Zákazník Nedostupné",
    statusName: DEFAULT_ORDER_OPEN_STATUS,
    placedAt: new Date("2026-07-27T09:00:00Z"),
    email: "e2e-nedostupne@forestshop.sk",
  })
  .returning();
if (objednavkaNedostupne === undefined) throw new Error("E2E objednávka (nedostupné) sa nepodarila vložiť");
await db.insert(orderLines).values({ orderId: objednavkaNedostupne.id, variantCode: "40287", quantity: 1, state: "nedostupne" });

// issue 238: preklik na náš e-shop (názov produktu) a na dodávateľa (kód) na
// obrazovke "Nedostupné tovary" — variant "40287" (rovnaký ako vyššie) má vo
// fixtúre PRÁZDNY `internalNote` (overené priamo na fixtúre, `.claude/rules/
// catalog.md`), takže preklik na dodávateľa musí ísť cez RUČNÝ override
// (`product_supplier_link_override`), nie extrahovaný odkaz. Produktkey je
// exportov `guid` stĺpec (identita produktu, `.claude/rules/catalog.md`),
// overené priamym dopytom proti reálne naimportovanej fixtúre.
await db.insert(shopProductUrl).values({
  code: "40287",
  url: "https://www.forestshop.sk/e2e-nedostupne-40287/",
  fetchedAt: new Date("2026-07-27T09:00:00Z"),
});
await db.insert(productSupplierLinkOverrides).values({ productKey: "d63e07c9-3c48-11e6-8a3b-0cc47a6c92bc", url: "https://dodavatel.example/e2e-nedostupne-40287", updatedAt: new Date("2026-07-27T09:00:00Z") });

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

// #115 (majiteľ: "nemoze tam bezat ok ked posledny sync bol dni dozadu!!!") —
// jeden UMELO ZOSTARNUTÝ, ÚSPEŠNÝ `job_run` pre import katalógu (nikdy sa
// nedotýka produkčných dát — toto je izolovaná testovacia DB), aby
// `nav.spec.ts`'s test staleness upozornenia mal čo overiť. Pevný dátum
// hlboko v minulosti (rovnaký vzor ako `objednavkaBezDodavatela.placedAt`
// vyššie) — zostáva "starý" navždy, bez ohľadu na to, kedy CI beh skutočne
// prebehne. `catalog-import` (nie `orders-import`) — `nav.spec.ts`'s ostatné
// testy neoverujú konkrétny obsah kanála "Objednávky", takže sa tu
// nekolíduje so žiadnym existujúcim tvrdením.
await db.insert(jobRuns).values({
  jobName: CATALOG_IMPORT_JOB_NAME,
  startedAt: new Date("2020-01-01T09:00:00Z"),
  finishedAt: new Date("2020-01-01T09:00:05Z"),
  status: "success",
  detail: { variantCount: 1 },
});

// issue 193: dva riadky knihy odoslaných e-mailov, aby `mail-log.spec.ts`
// overoval SKUTOČNÝ obsah obrazovky, nie prázdny stav. `created_at` je "teraz"
// (nie zostarnutý ako `job_run` vyššie) — obrazovka predvolene zobrazuje
// posledných 30 dní, takže starý dátum by riadky skryl. Žiadny e-mail sa tým
// neodosiela: sú to LEN záznamy o tom, čo appka kedysi urobila.
const teraz = new Date();
await db.insert(mailLog).values({
  createdAt: teraz,
  source: "posta_uncollected",
  status: "sent",
  trigger: "scheduled",
  templateKey: "posta_1",
  recipient: "e2e-zakaznik@example.com",
  bcc: "e2e-majitel@example.com",
  subject: "Zásielka čaká na pošte",
  orderCode: "9001",
  packageNumber: "RR000000001SK",
  sequence: 1,
});
await db.insert(mailLog).values({
  createdAt: teraz,
  source: "nedostupne",
  status: "skipped",
  trigger: "manual",
  templateKey: "nedostupne",
  recipient: "e2e-zakaznik@example.com",
  orderCode: "9002",
  variantCode: "4859/46",
  // Musí sa presne zhodovať s `DUPLICATE_REASON` (`modules/mail-log/
  // queries.ts`) — inak by súhrn "zabránené duplicity" ukázal nulu.
  reason: "už bolo odoslané skôr — druhý e-mail sa neposiela",
});

// issue 217: kandidáti na prepnutie „Vypredané → Skladom", aby overovacia
// obrazovka mala naživo čo ukázať. Zámerne VLASTNÉ produkty + varianty s
// kódmi, ktoré sa v žiadnom inom spec súbore nevyskytujú, a BEZ objednávkového
// riadku — nepridávajú teda nič do „Na objednanie" ani do parovania, kde iné
// testy počítajú presné počty. `supplier_stock` je tabuľka, ktorú nesleduje
// žiadny iný test.
// `vysledok.snapshotId` (import fixtúry vyššie) namiesto vlastného dopytu —
// priamy import z "drizzle-orm" v `scripts/` hlási falošné `no-unsafe-*`
// (`.claude/rules/testing.md`), takže sa mu tu vyhýbame úplne.
const snapshotPrepinanie = vysledok.snapshotId;
async function seedPrepinanieKandidata(key: string, code: string, name: string, odkaz: string, cena: string): Promise<void> {
  await db.insert(products).values({
    key,
    name,
    supplier: "DODAVATEL-PREPINANIE",
    internalNote: `Dodávateľ: ${odkaz}`,
    firstSeenAt: teraz,
    lastSeenAt: teraz,
    lastSeenSnapshotId: snapshotPrepinanie,
  });
  await db.insert(variants).values({
    code,
    productKey: key,
    guid: key,
    name,
    stock: 0,
    availabilityInStockText: "Skladom",
    availabilityOutOfStockText: "Vypredané",
    availabilityText: "Vypredané",
    productVisibility: "visible",
    state: "out_of_stock",
    firstSeenAt: teraz,
    lastSeenAt: teraz,
    lastSeenSnapshotId: snapshotPrepinanie,
  });
  await db.insert(supplierStock).values({
    link: odkaz,
    host: "huntingshop.eu",
    availability: "available",
    availabilityText: "skladom",
    price: cena,
    source: "json_ld",
    ok: true,
    httpStatus: 200,
    checkedAt: teraz,
    // Potvrdenie musí byť čerstvé (do 48 h), inak kandidát vypadne z výberu.
    confirmedAt: new Date(teraz.getTime() - 3_600_000),
  });
}
await seedPrepinanieKandidata("e2e-prepinanie", "PREP-1", "E2E Bunda na prepnutie", "https://huntingshop.eu/e2e-prepinanie", "49.90");

// issue 226: DRUHÝ kandidát (vlastný kód, nezrazí sa s "PREP-1") — máme ho ako
// vypredaný a dodávateľ ho potvrdene má, ALE feed pre porovnávače hovorí
// "in stock" (Shoptet ho už zobrazuje ako skladom). Presne ten rozpor, ktorý
// MUSÍ vylúčiť z kandidátov aj z overovacieho zoznamu a MUSÍ sa ukázať na
// obrazovke ako varovanie.
await seedPrepinanieKandidata("e2e-rozpor", "PREP-2", "E2E Bunda s rozporom voči feedu", "https://huntingshop.eu/e2e-rozpor", "39.90");
await db.insert(shopProductUrl).values({
  code: "PREP-2",
  url: "https://www.forestshop.sk/e2e-rozpor/",
  availability: "in stock",
  fetchedAt: teraz,
});

// issue 227: dva produkty pre "Prehľad podľa domény" + vylúčenie vlastného
// e-shopu — VLASTNÉ kódy, ktoré sa v žiadnom inom spec súbore nevyskytujú.
// `virginiashop.sk` má DVA riadky v `supplier_stock` (jeden čitateľný, jeden
// `unknown`), aby prehľad ukázal total=2/readable=1/unknown=1. Odkaz na
// `forestshop.sk` sa NIKDY nezapisuje do `supplier_stock` (run.ts ho
// vylučuje) — počíta sa živo z `internalNote`, žiadny riadok netreba.
async function seedDomenaProdukt(key: string, name: string, internalNote: string): Promise<void> {
  await db.insert(products).values({ key, name, internalNote, firstSeenAt: teraz, lastSeenAt: teraz, lastSeenSnapshotId: snapshotPrepinanie });
}
await seedDomenaProdukt("e2e-domeny-1", "E2E Nôž (virginiashop.sk)", "https://www.virginiashop.sk/e2e-domeny/noz-1/");
await seedDomenaProdukt("e2e-domeny-2", "E2E Nôž (virginiashop.sk, druhý)", "https://www.virginiashop.sk/e2e-domeny/noz-2/");
await seedDomenaProdukt("e2e-domeny-vlastny", "E2E Vlastný produkt (forestshop.sk)", "https://www.forestshop.sk/e2e-domeny-vlastny-produkt/");
await db.insert(supplierStock).values({ link: "https://www.virginiashop.sk/e2e-domeny/noz-1/", host: "virginiashop.sk", availability: "available", availabilityText: "Skladom", source: "text", ok: true, httpStatus: 200, checkedAt: teraz, confirmedAt: teraz });
await db.insert(supplierStock).values({ link: "https://www.virginiashop.sk/e2e-domeny/noz-2/", host: "virginiashop.sk", availability: "unknown", availabilityText: "", source: "none", ok: true, httpStatus: 200, checkedAt: teraz, confirmedAt: null });

// issue 237: JEDNA objednávka pre "Prehľad e-shopu" (dnes/tento
// týždeň/tento mesiac) — `placedAt: teraz` (rovnaké "teraz" ako mail_log
// riadky vyššie), aby vždy spadla do "dnes" bez ohľadu na to, kedy e2e beh
// skutočne prebehne. ZÁMERNE bez akéhokoľvek `order_line` — dashboard
// "Prehľad e-shopu" číta priamo `order` tabuľku (`orders/overview.ts`), nie
// cez `order_line` JOIN ako "Na objednanie" — objednávka bez riadku sa preto
// v `listOpenOrderLinesBySupplier` (INNER JOIN) vôbec nezobrazí a NEMENÍ
// žiadny existujúci "Všetci (N)"/"(bez dodávateľa) (N)" počet, ktorý ostatné
// testy overujú presne.
await db.insert(orders).values({
  externalOrderId: "9009",
  customerName: "E2E Zákazník Prehľad",
  statusName: DEFAULT_ORDER_OPEN_STATUS,
  placedAt: teraz,
  totalPriceWithVat: "77.50",
});

// issue 239: fixtúra (produkty + vlastný E2E účet) vyčlenená do vlastného
// súboru (eslint max-lines).
await seedProductLinksFixtures(db, teraz, snapshotPrepinanie, E2E_HESLO);

// issue 240: fixtúra vyčlenená do vlastného súboru, rovnaký dôvod ako vyššie.
await seedSearchFixtures(db, teraz, snapshotPrepinanie, E2E_HESLO);

// issue 290: fixtúra vyčlenená do vlastného súboru, rovnaký dôvod ako vyššie.
await seedOrderFlagsFixtures(db, E2E_HESLO);

// issue 311: fixtúra vyčlenená do vlastného súboru, rovnaký dôvod ako vyššie.
await seedRestockLinksFixtures(db, teraz, snapshotPrepinanie, E2E_HESLO);

// issue 292: fixtúra vyčlenená do vlastného súboru, rovnaký dôvod ako vyššie.
await seedDpdFixtures(db, E2E_HESLO);

// issue 329: fixtúra vyčlenená do vlastného súboru, rovnaký dôvod ako vyššie.
await seedRestockEventsFixtures(db, teraz);

// issue 337: fixtúra vyčlenená do vlastného súboru, rovnaký dôvod ako vyššie.
await seedPaginationFixtures(db, teraz, snapshotPrepinanie);

// issue 345: fixtúra vyčlenená do vlastného súboru, rovnaký dôvod ako vyššie.
await seedFloorOrdersFixtures(db, E2E_HESLO);

await pool.end();
