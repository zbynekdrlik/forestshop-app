---
paths:
  - "apps/api/src/modules/orders/**"
  - "apps/api/src/modules/mail/**"
  - "apps/api/src/http/supplier-routes.ts"
  - "apps/api/src/cli/orders-ingest.ts"
  - "scripts/orders-ingest.ts"
---

# Objednávky zo Shoptetu (F3, #21)

- **Export je JEDEN riadok NA POLOŽKU OBJEDNÁVKY, nie na objednávku.**
  Order-level polia (`code`, `date`, `billFullName`, …) sa OPAKUJÚ na
  každom riadku tej istej objednávky — importer si preto vezme prvý
  výskyt na objednávku (`ingest.ts`'s `orderInfo` mapa), nie posledný ani
  všetky naraz.
- **`itemCode` nie je vždy skutočný produkt.** Shoptet doň zapisuje aj
  pseudo-položky objednávky — dopravu (`SHIPPING*`), platbu (`BILLING*`),
  zľavu (`DISCOUNT`), zistené naživo 2026-07-29. `parser.ts`'s
  `PSEUDO_ITEM_CODE_RE` ich prefixovo odfiltruje (case-insensitive) PRED
  akýmkoľvek DB dopytom — bez toho by FK na `variant.code` zhodilo celú
  transakciu na prvej takej položke.
- **Ten istý produkt sa v tej istej objednávke niekedy objaví na DVOCH
  riadkoch** (napr. rozdelené množstvo pri úprave objednávky). `ingest.ts`
  ich zoskupí podľa (`externalOrderId`, `variantCode`) a množstvo SČÍTA —
  preto `order_line` má unikátny index `(order_id, variant_code)`
  (migrácia `0007_groovy_alice.sql`), ktorý #20 nemal (nebol preň ešte
  dôvod).
- **`itemCode`, ktorý prejde pseudo-filtrom, ešte nemusí byť ZNÁMY
  variant** (dávno vypnutý/premenovaný produkt). Autorita je AŽ dávkový
  `SELECT code IN (...)` proti `variant` v `ingest.ts` — neznámy sa
  preskočí + zaloguje (`skippedItemCount`), nikdy nezhodí import.
- **`date` nenesie časovú zónu — je to miestny čas Europe/Bratislava.**
  `parser.ts`'s `parseShopLocalDateTime` prevádza na UTC cez
  `Intl.DateTimeFormat` (guess-format-diff trik), NIE pevný offset
  (+1/+2) — pevný offset by pri prechode na/z letného času (posledná
  marcová/októbrová nedeľa) ticho posunul objednávky o hodinu. Testy
  pokrývajú explicitne letný (CEST) aj zimný (CET) dátum.
- **`dateFrom`/`dateUntil` čakajú `YYYY-M-D`, BEZ nuly na začiatku mesiaca/
  dňa** (overené `curl` proti reálnemu exportu) — `fetcher.ts`'s
  `formatDateParam` používa UTC gettery (nie lokálne), aby formátovanie
  nezáviselo od časovej zóny hostiteľa. Sú to obyčajné dátumy, nie
  tajomstvo — pridané do `redactUrl`'s allowlistu vedľa `patternId`/
  `partnerId`, inak by prekrytie skrylo presne to okno, ktoré operátor
  potrebuje vidieť pri ladení.
- **`order.comment` a `order_line.state` sú vlastníctvo manažéra/appky,
  NIKDY zo Shoptetu** — `ingest.ts`'s `onConflictDoUpdate` ich zámerne
  VYNECHÁVA zo `set`. Re-import smie osviežiť `customerName`/`placedAt`/
  `quantity`, nikdy nevrátiť rozpracovaný riadok naspäť na `objednane`
  ani vymazať manažérov komentár.
- **Objednávky nemajú snapshotovú tabuľku ako katalóg (zámerne)** — brána
  prijatia preto NEPOROVNÁVA proti "poslednému prijatému", ale proti tomu,
  čo je UŽ v databáze pre TO ISTÉ `placedAt` okno (dopyt v `ingest.ts`,
  po `pg_advisory_xact_lock`, presne ako katalógov `previousAccepted`).
  Pomer `previousLineRatio = 0.2` je zámerne benevolentnejší než
  katalógových 0.8 — objem objednávok kolíše oveľa viac deň-na-deň
  (víkendy, sezónnosť) než počet produktov v katalógu.
- **Advisory zámok kľúč `787_878_003`** (`INGEST_ORDERS_ADVISORY_LOCK_KEY`)
  — ďalší v registri `.claude/rules/scheduler.md`, nikdy nehádaj nový.
- **Nočný beh + retencia + HTTP rozhranie existujú (#22/#28/#23).**
  `ordersImportJob` (01:45 UTC) + `pruneRawOrdersJob` (02:00 UTC) sú
  registrované v scheduleri (`index.ts`) vedľa katalógových jobov — registrácia
  advisory zámkov aj časov je v `.claude/rules/scheduler.md`. Čítanie/ručný
  refresh ide cez `GET /api/orders/open`, `GET /api/orders/:id`,
  `POST /api/orders/ingest` (`http/orders-routes.ts` + `modules/orders/
  queries.ts`) — rovnaký štýl ako katalógové trasy. CLI (`pnpm orders:ingest`
  / `node apps/api/dist/cli/orders-ingest.js`) zostáva ako lokálny/CI vstupný
  bod aj núdzové produkčné tlačidlo, keď appka bežiaci proces z nejakého
  dôvodu nemá zmysel reštartovať.
- **`product.supplier` je NEPOVINNÝ stĺpec** (`text("supplier")`, bez
  `.notNull()`, `schema-catalog.ts`) — Shoptet export niekedy nesie prázdnu
  hodnotu (`map-row.ts`'s `textOrNull`). `modules/orders/queries.ts`'s
  zoskupenie "Na objednanie" podľa dodávateľa preto mapuje `null` na
  čitateľný zástupný kľúč (`"(bez dodávateľa)"`), nikdy netriedi/nezoskupuje
  priamo podľa `null`.
- **Retencia surových exportov objednávok (`pruneRawOrders`,
  `modules/orders/raw-prune.ts`) je ČISTO súborová (mtime), nie DB-riadená**
  ako katalógova `pruneRawSnapshots` — objednávky nemajú snapshotovú tabuľku
  (pozri vyššie), takže neexistuje DB riadok, cez ktorý by sa dala pohnať. Na
  rozdiel od katalógu preto NEEXISTUJE výnimka "posledný prijatý sa nikdy
  nemaže" — každý súbor sa posudzuje rovnako, len podľa veku.
- **`scripts/e2e-setup.ts` má VLASTNÝ, SAMOSTATNÝ `TRUNCATE` zoznam od
  `apps/api/tests/helpers/db.ts`** (#24) — pridanie novej "koreňovej"
  tabuľky (`.claude/rules/testing.md`'s `order`/`order_line` pravidlo,
  #20) treba urobiť na OBOCH miestach, nie len v integračných testoch.
  E2E-setup pôvodne `order`/`order_line` vôbec netruncatoval (objednávky
  vtedy ešte neexistovali) — pri prvom pridaní objednávkových dát do E2E
  (#24) to bolo treba doplniť ručne, rovnakým vzorom (`order_line,
  "order"` s ručne uvodzovaným rezervovaným slovom).
- **E2E objednávkové dáta (#24) sedia na UŽ naimportovaných katalógových
  fixtúrových variantoch, nie na ručne vloženom produkte/variante** —
  žiadne volanie `insertTestVariant`-ekvivalentu netreba. Dva variantné kódy
  z `apps/api/src/modules/catalog/fixtures/shoptet-sample.csv` majú známe,
  overené hodnoty užitočné pre ďalšie objednávkové E2E testy: `"4859/46"`
  (`product.supplier = "DODAVATEL-TEST-1"`, názov "Nohavice Hart Wild-T",
  `sizeLabel = "46"`) a `"40287"` (`supplier = null` → zoskupí sa pod
  "(bez dodávateľa)", názov "Čiapka Polar FOREST", `sizeLabel = null`,
  jednovariantný). Over cez `map-row.test.ts`, ak fixtúra niekedy zmení
  obsah.
- **Fixtúra (`fixtures/orders-sample.csv`) je ručne vyrobená z reálnej
  67-stĺpcovej hlavičky** (nie výrez reálneho exportu ako katalóg — export
  objednávok nesie mená a e-maily zákazníkov, tie sa nekomitujú), cp1250
  cez `iconv -f utf-8 -t windows-1250`. Obsahuje zámerne: duplicitný riadok
  rovnakého produktu (sčítanie), pseudo-položku (`SHIPPING6`), neznámy
  variant (`99999/ZZ`), prázdny `itemCode` — pokrýva všetky preskočené
  triedy naraz.
- **Odoslanie objednávky dodávateľovi mailom (#31)** — `modules/orders/
  mail.ts` (agregácia + textový formát), `modules/mail/transport.ts`
  (SMTP cez `nodemailer`, env premenné `MAIL_*` v `env.ts`) a
  `http/supplier-routes.ts` (PUT e-mailu, GET náhľad, POST odoslanie).
  Nová root tabuľka `supplier_contact` je kľúčovaná PRESNE tým reťazcom,
  aký `queries.ts` zobrazuje ako `supplier` (vrátane zástupného
  "(bez dodávateľa)"), NIE priamo na `product.supplier` — bez FK, pridaná
  do OBOCH truncate zoznamov (rovnaký dôvod ako `order`/`order_line`
  vyššie, `testing.md`). Textový formát verne kopíruje starú appku's
  `orderCopyLines` (`kód | grube-id | veľkosť | N ks | url`,
  `.filter(Boolean).join(' | ')`), ale nová schéma NEMÁ ani
  per-dodávateľské "grube id", ani URL produktu — tie dve polia preto v
  tom istom `filter(Boolean)` reťazci VŽDY vypadnú (nikdy sa nehádali,
  štruktúrovo neexistujú). Ak niekedy pribudne URL produktu alebo podobný
  identifikátor do `variant`/`product`, doplň ho do
  `formatSupplierOrderMailLine` — mechanizmus je už pripravený, len chýba
  zdroj dát. Agregácia beží LEN nad riadkami v stave `objednane` (ešte
  neposlané ďalej) pre daného dodávateľa, súčet množstva podľa
  `variant.code` (veľkosť je súčasťou kódu variantu). Odoslanie NIKDY
  nemení `order_line.state` — manažér ho posúva ručne cez existujúci
  select. E2E test odoslanie NIKDY neklika (žiadny `MAIL_HOST` v
  `playwright.config.ts`'s webServer env → server by na "Odoslať" vrátil
  503, čo by zalogovalo console error a porušilo jedinú povolenú výnimku,
  `testing.md`) — E2E overuje len nastavenie e-mailu + náhľad, skutočné
  odoslanie má integračný test s falošným transportom
  (`supplier-mail.integration.test.ts`).
