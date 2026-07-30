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
- **UI "✉️ Poslať objednávku e-mailom" je DVOJKROKOVÉ.** Prvý klik len
  otvorí náhľad (komu/predmet/telo) s tlačidlami "Odoslať"/"Zrušiť" priamo
  pod pôvodným tlačidlom — skutočný `POST .../order-mail/send` ide až po
  druhom kliku na "Odoslať". Pri manuálnom/Playwright overovaní na živom
  systéme na to netreba zabudnúť (#38, 2026-07-30) — jeden klik ešte nič
  neodošle.
- **`MAIL_HOST/PORT/USER/PASS/FROM` na dev2 sú od #38 (2026-07-30) reálne
  nastavené** — appka odosiela cez ROVNAKÚ SMTP schránku ako stará appka
  (`parovanie_produktov`, majiteľovo rozhodnutie), hodnoty prevzaté z jej
  gitignorovaného `data/.mail_env`. Overené end-to-end reálnym mailom cez
  dočasný `supplier_contact` kontakt nastavený na majiteľovu vlastnú
  adresu, po overení znova odstránený. `MAIL_BCC` (BCC-vždy konvencia
  starej appky) táto appka zatiaľ NEPODPORUJE vôbec (nie je v `env.ts` ani
  `transport.ts`) — vedomé rozhodnutie mimo rozsahu #38, nie prehliadnutá
  medzera; ak niekedy pribudne, ide do `env.ts` vedľa `MAIL_FROM` a
  `createSmtpMailTransport`'s recipient zoznamu.
- **Objednávka nesie Shoptet-ov `status_name` (issue 59)** — order-level
  pole ako `customerName`/`placedAt` (opakuje sa na KAŽDOM riadku tej istej
  objednávky, importer berie prvý výskyt), normalizované `normalizeStatusName`
  (NFC + orez, `parser.ts`) rovnakým vzorom ako stará appka's `norm_status` —
  MUSÍ byť rovnaká normalizácia na oboch stranách porovnania (export vs.
  `order_open_status`), inak sa zhoda nikdy nenájde. Na rozdiel od
  `comment`/`order_line.state` (appkou/manažérom vlastnené, re-import ich
  NEPREPÍŠE) je `status_name` VŽDY Shoptetovo pole — re-import ho vždy
  OSVIEŽI. `order_open_status` (nastaviteľný zoznam "ešte sa vybavuje",
  `modules/orders/open-statuses.ts`) rozhoduje, čo ukáže "Na objednanie"
  (`queries.ts`'s `listOpenOrderLinesBySupplier`) — zámerne LEN tento jeden
  zoznam, nie stará appka's `to_order`/`terminal`/`known_open`/`cancelled`
  štvorica (tie tri navyše existujú len kvôli "Nedostupné" tabu a
  pripomienkovým e-mailom, ktoré táto appka nemá).
- **`orders-ingest.integration.test.ts`'s `buildCsv` vracia UTF-8 Buffer, ale
  `ingestOrders` VŽDY dekóduje ako windows-1250** (`decodeCp1250`, rovnaký
  zámer ako skutočný Shoptet export) — akýkoľvek non-ASCII znak (diakritika)
  priamo v `buildCsv`-vytváraných riadkoch preto vyjde na druhej strane
  pokazený (mojibake, napr. "Vybavená" → "VybavenĂˇ"), lebo dva bajty UTF-8
  znaku sa dekódujú ako DVA samostatné cp1250 znaky. Testy nad `buildCsv`
  preto zostávajú ASCII-only — skutočná diakritika sa testuje cez
  commitnutú fixtúru (`fixtures/orders-sample.csv`), ktorá JE natívne cp1250
  na disku.
- **`order_line.ordered` (issue 60) je NEZÁVISLÝ boolean od `order_line.state`
  enumu — nezamieňať.** `state` (objednane/caka_sa/skladom/nedostupne) sleduje
  POSTUP u dodávateľa (a jeho `objednane` hodnota je VÝCHODISKOVÝ/predvolený
  stav riadku — vo frontende zobrazený ako "Nevybavené", NIE "Objednané", od
  issue 60). `ordered` je samostatný príznak "manažér toto reálne objednal u
  dodávateľa" (checkbox + hromadné tlačidlo na "Na objednanie", `state.ts`'s
  `setOrderLineOrdered`/`setSupplierLinesOrdered`) — rovnaký zámer ako stará
  appka's samostatný `ORDERED` flag, oddelený od WAITING/INSTOCK/UNAVAIL.
  Manažér ho môže odškrtnúť v ĽUBOVOĽNOM `state`; mailová agregácia (`mail.ts`)
  aj ďalej filtruje LEN podľa `state === "objednane"`, `ordered` na ňu vôbec
  nevplýva. Ďalšia funkcia, ktorá by potrebovala "bolo toto už vybavené",
  siahni po `ordered`, nie po pridávaní ďalšej hodnoty do `state` enumu.
- **Audit `entity` musí byť to, čo sa REÁLNE MUTUJE, nikdy zoskupovací kľúč
  vstupu.** Code review na PR 75 (finding 1): `setSupplierLinesOrdered`
  (hromadné "objednané" na CELÚ skupinu dodávateľa, `state.ts`) pôvodne
  zapisovala `entity: "supplier_contact"` len preto, že VSTUP je dodávateľ —
  ale mutuje `order_line` riadky, takže audit dopyt filtrovaný podľa
  `entity = "order_line"` ju ticho vynechával a filter podľa
  `"supplier_contact"` ju miešal s nesúvisiacimi udalosťami e-mailového
  kontaktu (`supplier-routes.ts`'s `email`/`order-mail/send`). Oprava:
  `entity` rovnaké ako pri KAŽDEJ inej `order_line`-mutujúcej akcii v tomto
  súbore (`"order_line"`), `entityId: null` (žiadny JEDEN riadok pri
  hromadnej akcii), dodávateľ + zasiahnuté ID zostávajú v `data`. Test pre
  ĎALŠIU hromadnú/agregovanú akciu: `entity` sa vždy odvodzuje od TOHO, ČO sa
  v DB mení, nie od parametra, podľa ktorého sa vyberajú riadky.
  Podrobný TOCTOU fix (finding 3, presun `listOpenOrderLineIdsForSupplier`
  do tej istej transakcie s `.for("update")`) je zdokumentovaný v
  `.claude/rules/database.md` (Postgres `FOR UPDATE` bez `OF` zoznamu
  zamyká celý JOIN, nielen primárnu tabuľku).
- **Kanonická definícia "vybavený riadok" (issue 61) je
  `apps/web/src/ordersSummary.ts`'s `isLineResolved` — `ordered || state !==
  "objednane"`.** Priamy náprotivok starej appky's `isHandled` (`ORDERED ||
  WAITING || INSTOCK || UNAVAIL`) — nový `ordered` nahrádza jej `ORDERED`,
  tri ne-predvolené `state` hodnoty nahrádzajú `WAITING`/`INSTOCK`/
  `UNAVAIL`. Ktorákoľvek ĎALŠIA funkcia, čo potrebuje "je tento riadok
  vybavený/hotový" (napr. budúci dashboard, ďalší filter), nech importuje
  `isLineResolved`/`summarizeOrderLines` odtiaľ — nie novú vlastnú
  definíciu, riziko rozídenia (napr. počítať len podľa `state`, čo by
  ignorovalo `ordered=true` pri `state="objednane"`).
- **Kanonické per-produktové zoskupenie naprieč riadkami DODÁVATEĽA (issue
  62) je `apps/web/src/ordersSummary.ts`'s `computeVariantTotals`/
  `formatVariantTotalChip`** — priamy náprotivok starej appky's
  `groupQtyTotals`/`totalChipSpec` (`app.js:1918-1962`). Kľúčuje podľa
  `variantCode` (kód UŽ nesie aj veľkosť), počíta nad CELOU (nefiltrovanou)
  `group.lines` danej skupiny, nikdy nad pohľadom zúženým `hideResolved` —
  volajúci (`OrdersSection.tsx`) posiela vždy `group.lines`. Chip sa smie
  zobraziť LEN keď produkt má v skupine ≥2 riadky (`lineCount >= 2`) A ešte
  zostáva niečo objednať (`remaining > 0`, issue 63 — pôvodne sa rozhodovalo
  LEN podľa `lineCount`, takže celý vybavený opakovaný produkt navždy
  ukazoval "Σ spolu 0 ks"). Ako odvodená hodnota počítaná PRI KAŽDOM RENDRI
  (rovnaký vzor ako `isLineResolved`/`summarizeOrderLines` vyššie) sa
  automaticky prepočíta na akúkoľvek zmenu `suppliers` stavu — žiadny extra
  React stav, žiadny imperatívny prepočítavací krok. ĎALŠIA funkcia
  potrebujúca "súčet toho istého produktu v rámci dodávateľa" nech
  importuje odtiaľto, nie novú vlastnú definíciu.
- **Efektívny dodávateľ riadku (issue 63) je `apps/api/src/modules/orders/
  supplier-key.ts`'s `effectiveSupplierSql`** — `coalesce(product.supplier,
  product_supplier_override.supplier)`, LEFT JOIN na novú tabuľku
  `product_supplier_override` (kľúčovanú `product.key`, migrácia 0014).
  Toto (nie holé `products.supplier`) je odvtedy jediný správny zdroj
  "aký dodávateľ patrí tomuto riadku" na VŠETKÝCH troch čítacích cestách —
  `queries.ts`'s `listOpenOrderLinesBySupplier` +
  `listOpenOrderLineIdsForSupplier` (hromadná akcia) a `mail.ts`'s
  `loadOutstandingLines`. Zoskupenie/porovnanie je NAVYŠE
  case/whitespace-insensitive (`normalizedSupplierKeySql`/
  `normalizeSupplierKeyJs`, priamy náprotivok legacy `supKey`) — dva
  pravopisy toho istého mena (case/medzery) sú VŽDY jedna skupina, aj keď
  jeden pochádza z katalógu a druhý z ručného priradenia. Zobrazovaný
  pravopis pri zlúčení: `pickCanonicalSupplierSpelling` (najčastejší podľa
  počtu riadkov, remíza → abecedne). ĎALŠIA funkcia, ktorá potrebuje "aký
  dodávateľ", nech použije `effectiveSupplierSql` (SQL strana) alebo číta z
  už vrátenej `SupplierOpenOrders.supplier`/`OpenOrderLine.
  manualSupplierOverride`, nikdy priamo `products.supplier` — to by ticho
  ignorovalo ručné priradenie a nezlúčilo by rozdielne pravopisy.
  Override je zámerne len FALLBACK (ľavá strana `coalesce` vyhráva) — keď
  Shoptet raz dodá reálnu hodnotu, tá prebije ručné priradenie, nikdy
  naopak (ticket to žiada explicitne: priradenie je pre riadok BEZ
  dodávateľa, nie trvalý pin).
- **Pravidlo vypočítané na ČÍTACEJ strane (`supplierAssignable` v tomto
  súbore) sa NIKDY nesmie spoliehať na to, že ho vynúti len FRONTEND.**
  Issue 86 (nezávislý audit po issue 63): `supplier-assignment.ts`'s
  `assignOrderLineSupplier` mala pôvodný SELECT len cez `variants`, vôbec
  nejoinovala `products` — takže nemala ako overiť, že produkt naozaj nemá
  dodávateľa, hoci presne TÚTO podmienku frontend (`OrderLineRow.tsx`)
  používal na skrytie/zobrazenie vstupu. Zabudnutá otvorená stránka, priame
  API volanie, alebo súbeh s nočným importom katalógu mohli zapísať
  dormantný override aj pre produkt so skutočným dodávateľom. Fix: SELECT
  join na `products`, podmienka vyhodnotená VNÚTRI TEJ ISTEJ transakcie ako
  upsert, nový návratový stav namapovaný na HTTP 409. Test na KAŽDÝ ďalší
  zápis, ktorého "kedy sa smie použiť" je odvodené od nejakého čítacieho
  dopytu/vypočítaného poľa: over, či ZÁPISOVÁ funkcia tú istú podmienku
  overuje SAMA, nie len že ju UI pred odoslaním skryje.
- **`apps/web/src/ordersApi.ts`'s `readJson`/`serverErrorMessage` zobrazí
  ĽUBOVOĽNÉ `{error: "..."}` telo pri ĽUBOVOĽNOM ne-200 HTTP stave** (401 je
  jediná špeciálna výnimka, `OrdersUnauthorizedError`) — pridanie NOVÉHO
  HTTP stavu na existujúcej trase (napr. 409 pri issue 86) preto nepotrebuje
  ŽIADNU zmenu frontendu, hláška sa zobrazí cez existujúci `stateError`
  banner automaticky. Pri pridávaní ďalšieho chybového stavu na už
  používanú zápisovú trasu najprv over, či `readJson` volajúcej funkcie už
  nerieši všeobecný prípad — často áno.
