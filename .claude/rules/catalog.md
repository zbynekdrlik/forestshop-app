---
paths:
  - "apps/api/src/modules/catalog/**"
  - "apps/api/src/http/catalog-routes.ts"
  - "apps/web/src/catalogApi.ts"
  - "apps/web/src/components/CatalogPage.tsx"
  - "scripts/catalog-*.ts"
  - "apps/api/src/cli/catalog-*.ts"
---

# Katalóg zo Shoptetu

- **Export je cp1250, `;`-oddelený, 265 stĺpcov, ~14 000 riadkov, ~54 MB** a popisy
  obsahujú zalomenia riadkov vnútri zacitovaných buniek. Preto je parser vlastný
  (`csv.ts`) a nie knižnica; dekóduje ho vstavaný `TextDecoder("windows-1250")`,
  žiadna závislosť. Hlavička končí bodkočiarkou, takže posledný (265.) stĺpec má
  prázdne meno — `columns` si ho ponecháva, do záznamu riadku sa nedáva.
- **`code` je identita variantu. Identita produktu je export's `guid`** (review
  task-5-fix-1), NIE prefix `code` pred prvou lomkou — merané na reálnom exporte,
  prefixové zoskupovanie bolo v oboch smeroch chybné (zlučovalo nesúvisiace
  produkty pod ten istý prefix, rozdeľovalo jeden produkt naprieč viacerými
  prefixmi). `guid` je stabilný identifikátor zo Shoptetu, jeden na produkt, na
  KAŽDOM riadku — je aj `product.key`, aj samostatný stĺpec `variant.guid` (uložený
  priamo na riadku, nezávisle od FK, presne z rovnakého dôvodu ako gzipnuté surové
  bajty nižšie). `pairCode` NIE je identita ani produktu ani variantu — je len
  poradové číslo od Shoptetu a pri ~2 700 jednovariantných produktoch je prázdne.
  `code`-prefix pred prvou lomkou si ponecháva len odvodenie `sizeLabel`
  (`40237/3XL` → veľkosť `3XL`).
- **Dostupnosť je voľný text, nie číselník.** Reálne pozorované hodnoty: `Skladom`,
  `Skladem`, `Vypredané`, `Predaj výrobku skončil`, `Není skladem`,
  `Momentálne nedostupné`, `Dodanie 1-3 dni`, `Na dotaz`, `Predobjednávka`. Pôvodný
  text sa ukladá nezmenený, stav (`sellable`/`out_of_stock`/`discontinued`) sa z neho
  ODVODZUJE v `availability.ts`. Nový text pribudne → doplň pravidlo AJ test tam,
  nikdy nie „opravou" uloženého textu.
- **`variantVisibility` je per-variantný prepínač, NEZÁVISLÝ od `productVisibility`**
  (final-wave-b, položka 5.3 — rozhodnuté POUŽIŤ ho, nie len nechať ako
  štrukturálny/povinný stĺpec bez efektu). Skutočné hodnoty v exporte: "0"
  (Shoptet vypol PRÁVE TENTO variant, napr. jednu veľkosť z radu), "1", alebo
  prázdny reťazec (~2 700 jednovariantných produktov ho často nevypĺňa —
  prázdny sa berie ako viditeľný, nikdy ako vypnutý). `deriveVariantState`
  (`availability.ts`) ho zohľadňuje AŽ PO silnejších signáloch (text/
  `productVisibility` hovoriaci "discontinued") — "0" vynúti aspoň
  `out_of_stock`, nikdy neprebíja `discontinued`. Nepretrváva vo `variant`
  tabuľke — ovplyvňuje len odvodenie `state` pri importe, žiadny ďalší
  konzument ho po importe nepotrebuje.
- **Brána prijatia (`validation.ts`) je to, čo drží #277, #281 a #286 mimo.** Kontroluje
  v poradí: neprázdnosť a minimálnu veľkosť, prítomnosť povinných STĹPCOV (vrátane
  `guid` od review task-5-fix-1 — identita produktu, odmietne sa rovnako ako
  chýbajúci `supplier`), počet poškodených riadkov, počet POUŽITEĽNÝCH záznamov
  proti počtu rozparsovaných riadkov (`usableRecordCount`, review task-5-fix-1 —
  export s prázdnym `code` na každom riadku inak prejde a blanketový missing-update
  vymaže celý katalóg), a napokon počet riadkov proti PODLAHE. Podlaha je MAXIMUM
  z pomerovej hranice (80 % posledného prijatého importu) a absolútnej hranice
  1 000 riadkov — NA KAŽDOM importe, nielen prvom. Samotná pomerová hranica by sa
  dala ratchetnúť smerom k nule cez opakované, mierne klesajúce prijaté exporty
  (napr. 1 → 0, lebo floor(1 × 0,8) = 0) — presne to bol incident #286, dosiahnutý
  cez bránu postavenú na to, aby mu zabránila. Nikdy sem nepridávaj „fail-open" vetvu.
- **Úplne PRVÝ import sa nemá voči čomu overiť — je to dôvera pri prvom použití
  (trust-on-first-use), nie chyba brány.** Bez predchádzajúceho prijatého snapshotu
  platí len absolútna podlaha (`absoluteMinRows`); skrátený alebo len čiastočný
  prvý export ju pokojne prejde a stane sa ZÁKLADOM pre KAŽDÉ ďalšie porovnanie
  (pomerová hranica sa odvodzuje práve od neho). Toto je NAJHODNOTNEJŠIA
  prevádzková inštrukcia celej fázy: prvý prijatý import musí človek vizuálne
  skontrolovať (napr. cez `/api/catalog/snapshots` + náhľad pár variantov na
  stránke) — brána sama chybný prvý import zachytiť nevie, a žiadny neskorší
  import ju už nezachráni, len na nej stavia ďalej.
- **Anomálie z ODMIETNUTÉHO exportu sa NEZAPÍŠU — sú vypočítané a zahodené.**
  `ingestCatalog` (`ingest.ts`) vracia `rejected` verdikt PRED vložením do
  `ingest_issue` (ten insert je až za `if (judgement.verdict === "rejected") { …
  return …; }`), takže po odmietnutí neostáva žiadny riadok anomálie — jediný
  dôkaz je gzipnutý surový súbor v `CATALOG_RAW_DIR` (pozri nižšie), na ktorý
  treba shell prístup k Docker zväzku. Nehľadaj anomálie odmietnutého importu v
  `ingest_issue` — tam nikdy neboli.
- **Konflikt DODÁVATEĽA v rámci produktovej skupiny je TICHO first-wins —
  nevyrába anomáliu.** `ingestCatalog`'s slučka cez `productValues` kontroluje
  LEN nezhodu `name` (vyrobí `product_name_conflict`); nezhodu `supplier` medzi
  riadkami toho istého `productKey` nekontroluje vôbec — vyhráva ten dodávateľ,
  ktorý sa v exporte objaví PRVÝ, ostatné sa ticho zahodia. Žiadny anomáliový
  druh preň dnes neexistuje. Párovanie produktov v neskoršej fáze bude kľúčovať
  podľa dodávateľa, takže toto pravidlo je dôležité poznať VOPRED — ak sa niekedy
  pridá `ingestIssueKind` pre konflikt dodávateľa, riaď sa rovnakým vzorom ako
  `product_name_conflict`.
- **Testy nikdy nesťahujú zo Shoptetu.** Sťahovanie je za `ExportFetcher`, testy dodajú
  vlastný. Fixtúra `apps/api/src/modules/catalog/fixtures/shoptet-sample.csv` je 35
  riadkov vyrezaných z reálneho exportu (celé skupiny 40237, 40269, 40287, 60055, 278,
  60035, BR1611, 4859), v cp1250 a s pôvodnou hlavičkou. Fixtúra má 35 riadkov, takže
  testy aj `scripts/e2e-setup.ts` posúvajú limity brány (`minByteSize: 1_000`,
  `absoluteMinRows: 10`) — pomer 0,8 zostáva rovnaký ako v produkcii.
- **Import beží v jednej transakcii po dávkach 500 riadkov.** Väčšia dávka narazí na
  limit 65 535 parametrov na príkaz v protokole Postgresu (tabuľka `variant` má
  25 stĺpcov po pridaní `guid`, review task-5-fix-1). Ako PRVÝ príkaz v transakcii
  beží `pg_advisory_xact_lock` s jedným pevným kľúčom — serializuje VŠETKY súbežné
  importy voči tejto databáze, nielen tie s rovnakým obsahom (review task-5-fix-1) —
  bez neho by dva súbežné importy RÔZNYCH bajtov mohli navzájom prepísať
  `missing_since` značenie toho druhého.
- **Idempotencia je na sha256 obsahu** cez čiastočný unikátny index
  `catalog_snapshot_accepted_sha_uq` (len `verdict = 'accepted'`). Odmietnuté snapshoty
  sa smú opakovať — prázdny export sa môže stiahnuť koľkokrát chce a každý pokus má
  zostať zapísaný. Súbežný import ROVNAKÉHO obsahu, ktorý napriek zámku vyššie stihne
  naraziť na tento index, sa prekladá na normálny `duplicate` výsledok, nikdy na
  uniknutú výnimku (review task-5-fix-1). Zlyhanie materializácie UPROSTRED
  transakcie (ROLLBACK) zapíše samostatný `rejected` dôkazový záznam s tým istým
  `content_sha256`/`raw_path` — inak by uložené surové bajty (zapísané PRED
  transakciou) zostali navždy bez záznamu, čo by naň ukazoval (review task-5-fix-1).
- **Variant, ktorý zmizne z exportu, sa NEMAŽE** — nastaví sa `missing_since`. Keď sa
  vráti, `missing_since` sa vynuluje v tom istom UPSERTe.
- **Surové bajty nie sú v Postgrese.** Ležia gzipnuté v `CATALOG_RAW_DIR` (na dev2
  docker zväzok `catalog-raw`), v databáze je len `raw_path` + `content_sha256`.
  `pg_dump` ich teda NEZAHŔŇA — a nemusí, odvodený katalóg je celý v databáze.
  Retencia (`pnpm catalog:prune-raw`): prijaté staršie než 30 dní prídu o súbor,
  odmietnuté si ho nechávajú navždy, posledný prijatý sa nemaže nikdy. `pruneRawSnapshots`
  (`raw-store.ts`) pracuje LEN cez riadky databázy — nikdy neprechádza adresár na
  disku — takže osirotený súbor bez zodpovedajúceho riadku nikdy nezmaže ani naň
  nenarazí, a `rm(..., { force: true })` mlčky prežije aj súbor, ktorý na disku už
  chýba (napr. zmazaný mimo appky).
- **CLI vstupné body (`pnpm catalog:ingest`, `pnpm catalog:prune-raw`) hlásia
  poctivo.** `catalog:ingest` končí nenulovým exit kódom LEN pri `rejected` verdikte
  (nikdy pri `duplicate` — to je legitímny no-op úspech, katalóg je aktuálny);
  operátor sa má spoliehať na `$?`, nie len na text výstupu (final-wave-b, položka
  1 — pripnuté testom, ktorý skutočný skript spúšťa ako podproces cez `tsx`, nie
  len funkciu pod ním). Obe skripty vypisujú jednu ľudskú slovenskú vetu AJ jeden
  JSON riadok (strojovo spracovateľný) — bez nastaveného `SHOPTET_EXPORT_URL`
  skript zlyhá nahlas hneď na štarte, nikdy ticho.
- **`catalog:prune-raw` má DVE kópie, zámerne — `scripts/catalog-prune-raw.ts` je
  len tenký alias.** Kanonická implementácia žije v `apps/api/src/cli/
  catalog-prune-raw.ts` (súčasť `apps/api`'s vlastného `tsc -b`), skompiluje sa
  do `apps/api/dist/cli/catalog-prune-raw.js` a BEŽÍ V PRODUKCII (`.claude/rules/
  deploy.md`) — `docker compose -f docker-compose.prod.yml exec app node
  apps/api/dist/cli/catalog-prune-raw.js` (bez `-f docker-compose.prod.yml` by
  compose na dev2 siahol po vývojovom `docker-compose.yml`). Overené naživo na
  dev2 2026-07-29 po nasadení v0.2.0: `Zmazaných surových súborov: 0 (staršie
  než 30 dní).` + `{"removed":0}`. Dôvod: dev2 má `scripts/` len ako `rsync`-nutú kópiu BEZ
  `node_modules` (final-wave-b, položka 2), takže `tsx scripts/catalog-prune-raw.ts`
  tam nemá ako bežať — bez skompilovanej verzie v obraze retencia v produkcii
  nemala žiadny spôsob spustenia a `catalog-raw` zväzok rástol donekonečna.
  `catalog:ingest` túto duplicitu NEPOTREBUJE — import beží aj cez tlačidlo na
  webe (`POST /api/catalog/ingest`, priamo v bežiacom procese appky), takže
  `scripts/catalog-ingest.ts` zostáva len pohodlný LOKÁLNY/CI vstupný bod.
- **`SHOPTET_EXPORT_URL` je tajomstvo** (prihlasovací `hash` je v query parametri). Do
  databázy ani do logov nesmie ísť celá — vždy cez `redactUrl`. V repe nikdy nie je.
  Na dev2 zatiaľ nie je nastavené (issue #8) — appka bez neho beží ďalej (premenná je
  v `env.ts` `.optional()`), len ručný import vráti 503.
- **`redactUrl` (`fetcher.ts`) prekrýva ALLOWLISTOM, nie denylistom** (review
  final-wave-a, položka 2) — prekryje HODNOTU KAŽDÉHO query parametra okrem
  malého zoznamu známych neškodných (`patternId`, `partnerId`); pôvodne to
  bolo naopak (prekrýval sa len parameter menom presne `hash`). Nový export s
  prihlasovacím údajom pod INÝM menom parametra sa tak prekryje automaticky —
  nikdy nepridávaj ďalší parameter do allowlistu bez istoty, že nenesie
  tajomstvo.
- **`fetcher.ts`'s `readBounded` číta telo odpovede PO ČASTIACH cez
  `response.body.getReader()`, nikdy `Buffer.from(await
  response.arrayBuffer())`** — to druhé by celé telo najprv zbufferovalo bez
  ohľadu na strop (`DEFAULT_MAX_EXPORT_BYTES`, 200 MB voči reálnemu ~57 MB
  exportu), takže by strop kontroloval AŽ PO vyčerpaní pamäte. Typovací
  detail: bez `dom` libu (`tsconfig`'s `"types": ["node"]`) je
  `Response.body` typovaný cez `undici-types` ako `ReadableStream` BEZ
  generika (efektívne `<any>`) — `getReader()` treba pretypovať na
  `ReadableStreamDefaultReader<Uint8Array>`, inak ESLint hlási
  `@typescript-eslint/no-unsafe-*` na každom `value`/`byteLength`.
