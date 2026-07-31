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
import { orderLines, orderOpenStatuses, orders, pairings, users } from "../apps/api/src/db/schema.js";
import { hashPassword } from "../apps/api/src/modules/auth/passwords.js";
import { ingestCatalog } from "../apps/api/src/modules/catalog/ingest.js";
import { DEFAULT_SNAPSHOT_LIMITS } from "../apps/api/src/modules/catalog/validation.js";
import { DEFAULT_ORDER_OPEN_STATUS } from "../apps/api/src/modules/orders/open-statuses.js";

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
// textom stavu, žiadny FK, CASCADE ho nikdy nestrhne.
await db.execute(
  'TRUNCATE TABLE ingest_issue, variant, product, catalog_snapshot, job_run, audit_events, sessions, users, order_line, "order", supplier_contact, pairing, supplier, order_open_status RESTART IDENTITY CASCADE',
);
// Rovnaký dôvod ako `tests/helpers/db.ts`: bez tohto by "Na objednanie" bolo
// v CELOM e2e behu prázdne pre KAŽDÚ objednávku (žiadny nastavený otvorený
// stav). Reseeduje presne to, čo produkčná migrácia zapíše na čerstvej DB.
await db.insert(orderOpenStatuses).values({ statusName: DEFAULT_ORDER_OPEN_STATUS });
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
await db.insert(users).values({
  email: E2E_NAV_EMAIL,
  passwordHash: await hashPassword(E2E_HESLO),
  displayName: "E2E Manažér",
  role: "manazer",
});
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
const [objednavkaSucetPrva] = await db
  .insert(orders)
  .values({
    externalOrderId: "9004",
    customerName: "E2E Zákazník Súčet Prvá",
    statusName: DEFAULT_ORDER_OPEN_STATUS,
    placedAt: new Date("2026-07-23T09:00:00Z"),
  })
  .returning();
if (objednavkaSucetPrva === undefined) throw new Error("E2E objednávka (súčet, prvá) sa nepodarila vložiť");
await db.insert(orderLines).values({
  orderId: objednavkaSucetPrva.id,
  variantCode: "60055/10",
  quantity: 3,
});

const [objednavkaSucetDruha] = await db
  .insert(orders)
  .values({
    externalOrderId: "9005",
    customerName: "E2E Zákazník Súčet Druhá",
    statusName: DEFAULT_ORDER_OPEN_STATUS,
    placedAt: new Date("2026-07-24T09:00:00Z"),
  })
  .returning();
if (objednavkaSucetDruha === undefined) throw new Error("E2E objednávka (súčet, druhá) sa nepodarila vložiť");
await db.insert(orderLines).values({
  orderId: objednavkaSucetDruha.id,
  variantCode: "60055/10",
  quantity: 2,
});

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
