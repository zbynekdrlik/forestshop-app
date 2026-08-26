---
paths:
  - "apps/api/src/modules/orders/**"
  - "apps/api/src/modules/mail/**"
  - "apps/api/src/http/supplier-routes.ts"
  - "apps/api/src/cli/orders-ingest.ts"
  - "scripts/orders-ingest.ts"
---

# Objednávky zo Shoptetu (F3, #21)

- **Hlásenie „appka nesedí so Shoptetom / Dnes: 0" — NAJPRV latencia, až
  potom stratené dáta (#436, 14. 8. 2026).** Import beží každú hodinu o :45;
  objednávka vzniknutá PO poslednom behu je v appke až o ďalšiu hodinu —
  rozdiel do ~1 h je normálny. Diagnostika v poradí: (1) `job_run` pre
  `orders-import` (status má byť `accepted`, `detail.orderCount`); (2) živý
  feed vs. DB `max(placed_at)` — chýba objednávka STARŠIA než posledný beh?
  Až to je skutočný bug. Pozor na dve neškodné anomálie: `orderCount` cez
  deň KLESÁ pri polnočnom posune 90-dňového okna (najstarší deň vypadne,
  by design), a sha256 raw súboru sa mení aj bez nových objednávok (Shoptet
  regeneruje obsah — mení sa stavové pole existujúcich objednávok). Fail-loud
  je pokrytý: prázdne telo = `rejected`, non-2xx = throw, HTML/login stránka
  padne na CSV validácii alebo 20 % acceptance gate — `success` s nulou
  nových teda znamená „nič nové vo feede", nie prehltnutú chybu.
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
- **Plánovaný beh + retencia + HTTP rozhranie existujú (#22/#28/#23).**
  `ordersImportJob` beží KAŽDÚ HODINU o :45 UTC (hodinová kadencia od #115,
  pôvodne denná 01:45 — `jobs.ts` `schedule: { kind: "hourly", minuteUtc: 45 }`);
  `pruneRawOrdersJob` ostáva denný (02:00). Oba registrované v scheduleri
  (`index.ts`) vedľa katalógových jobov — registrácia
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
- **`MAIL_HOST/PORT/USER/PASS/FROM` sú reálne nastavené od #38 (2026-07-30,
  vtedy na dev2 — od presunu appky, issue 366, sú rovnaké premenné v
  `/srv/forestshop/.env` na `forestshop-dev`, živo overené priamo v
  bežiacom kontajneri 12. 8. 2026, issue 371)** — appka odosiela cez
  ROVNAKÚ SMTP schránku ako stará appka (`parovanie_produktov`, majiteľovo
  rozhodnutie), hodnoty prevzaté z jej gitignorovaného `data/.mail_env`.
  Overené end-to-end reálnym mailom cez
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
- **Nezávislý audit k issue 86 upozornil na napätie medzi novým 409
  (`already_has_supplier`, vyššie) a `.claude/rules/testing.md`'s pravidlom
  "bežné, OČAKÁVANÉ doménové zlyhanie, ktoré sa niekedy overuje aj cez
  Playwright, nesmie vracať 4xx/5xx" (Chromium loguje "Failed to load
  resource" pre KAŽDÝ `fetch()` s ne-2xx odpoveďou, a nulová-konzola asercia
  v `orders.spec.ts` by na to spadla). Tento 409 je ARGUMENTOVATEĽNE presne
  taký prípad — súbeh (produkt medzitým dostal dodávateľa inou cestou) je
  bežná, očakávaná situácia, nie chyba servera. **Nemení sa na 200
  `{ok:false,error}`** (predpísaný vzor by bol rovnaký ako
  `/api/catalog/ingest`'s `{status:"busy"}`) — issue 89 to necháva zámerne
  otvorené, lebo dnešný `orders.spec.ts` tento konkrétny 409 vôbec
  neoveruje cez Playwright. Kto napíše PRVÝ e2e test tejto hlášky
  (banner po zamietnutom priradení), MUSÍ sa s týmto napätím vysporiadať
  ZÁMERNE — buď zmenou trasy na 200 `{ok:false,error}` (rovnaký vzor ako
  `sendSupplierOrderMail`), alebo explicitným filtrom v `jeOcakavane`
  (rovnaký vzor ako existujúca `/api/me` 401 výnimka). **Zakázané: "opraviť"
  to rozšírením konzolovej výnimky na hocijakú ĎALŠIU cestu/kód bez tejto
  úvahy** — presne to `testing.md` výslovne zakazuje.
- **Zápis, ktorý je vlastníctvom OBJEDNÁVKY (nie riadku) a zobrazuje sa na
  VIACERÝCH riadkoch naraz, potrebuje NAVYŠE "dirty" strážcu na reset efekte,
  nielen "skip prvý mount" guard.** Issue 64 (`PUT /api/orders/:id/comment` +
  `OrderLineRow.tsx`'s editovateľná bunka "Komentár"): `OrdersSection.tsx`'s
  `changeComment` aktualizuje `line.comment` na VŠETKÝCH riadkoch s rovnakým
  `orderId` (správne — poznámka patrí objednávke). Ale to znamená, že
  uloženie cez RIADOK B tej istej objednávky spustí `OrderLineRow.tsx`'s
  reset efekt AJ na RIADKU A — ktorý efekt (bez ďalšieho stráženia) nevie
  rozlíšiť "toto sa zmenilo, lebo som si to sám uložil" od "toto sa zmenilo,
  lebo niekto INÝ uložil poznámku tej istej objednávky odinakiaľ", a ticho
  by prepísal riadku A ešte NEULOŽENÝ rozpísaný koncept (našlo code review
  pred mergom, nie žiadny test — pozri `frontend-design.md`'s zodpovedajúci
  bod pre samotnú opravu). Test na KAŽDÉ ĎALŠIE pole vlastnené OBJEDNÁVKOU
  (nie riadkom), ktoré appka niekedy pridá s rovnakým "zobrazí sa na
  viacerých riadkoch" tvarom: má reset efekt na to pole `isDirty` strážcu,
  alebo len "skip prvý mount"? Ten druhý nestačí, keď zdroj resetu môže byť
  ULOŽENIE NA INOM RIADKU, nielen vlastné prvé mountnutie.
- **Export objednávok nesie DVA rôzne "poznámkové" stĺpce — `remark` (stĺpec
  27, poznámka ZÁKAZNÍKA) a `shopRemark` (stĺpec 28, INTERNÁ poznámka
  PREDAJNE) — nikdy si ich nezamieňaj podľa mena/nálepky.** Issue 65: stará
  appka (`parovanie_produktov`) svoju funkciu #101 "Poznámka e-shopu"
  vystavia `shopRemark` (jej vlastný komentár v `app.py:2978` to hovorí
  priamo, aj `.claude/skills/shoptet/SKILL.md:92`) — ale TENTO projekt
  potreboval presný OPAK: čo napísal ZÁKAZNÍK (`remark`), overené na reálnom
  cachovanom exporte (`parovanie_produktov/data/out/orders_cache.csv`):
  `remark` malo obsah v 75 z 1974 riadkov a boli to skutočné zákaznícke
  odkazy ("Prosim poslat co najskorej…"), `shopRemark` malo obsah v 1474
  riadkoch a boli to interné poznámky PREDAJNE ("Hart nie je tricko vyšiť
  riešim"). `shopRemark` by navyše koncepčne DUPLIKOVALO už existujúce
  appkine `order.comment` (issue 64, tiež interné). Pri KAŽDOM ďalšom poli
  z exportu, kde staršia dokumentácia/appka používa nejaké meno na
  obrazovke — over VÝZNAM stĺpca na reálnych dátach (nie z nálepky v UI).
- **Shoptet admin GET deep-link na objednávku podľa jej KÓDU (CSV export
  NEMÁ interné Shoptet id) je `/admin/vyhladavanie/?string=<kód>&src=orders`
  — NIE `?code=<kód>` na `objednavky-detail/`.** Issue 65: stará appka's
  `webreview/static/app.js:2253-2260` (staršie, NEFUNKČNÉ zistenie) používa
  práve ten druhý tvar — ale NOVŠIE, naživo overené zistenie (2026-07-22,
  `parovanie_produktov/src/parovanie/posta_uncollected.py:70-76` +
  `orders_reminder.py:36-38`) dokazuje, že Shoptet admin `?code=`/`?query=`
  na `objednavky-detail/` TICHO IGNORUJE, keď sa doň pošle KÓD (nie interné
  id) — vtedy funguje LEN globálne vyhľadávanie. Pri CITOVANÍ konkrétnych
  riadkov starej appky ako referencie pre nejaké správanie VŽDY over, či v
  tom istom repozitári neexistuje NOVŠIE zistenie, ktoré ho vyvracia (grep
  na kľúčové slovo, napr. `admin_link`/`ADMIN_ORDER_LINK`) — nie je isté, že
  prvý nájdený výskyt je ešte platný. Doména admin rozhrania patrí do
  `env.ts`'s novej, NIE-tajnej premennej (`SHOPTET_ADMIN_BASE_URL`, rozumný
  default = reálna produkčná hodnota) — nikdy natvrdo v kóde, presne ako
  `SHOPTET_EXPORT_URL`/`SHOPTET_ORDERS_URL` vyššie (aj keď táto NENESIE
  `hash`, teda nie je tajomstvo).
- **AKTUALIZÁCIA (issue 120, 2026-07-31): appka INTERNÉ Shoptet id predsa
  MÁ — len nie z CSV. Vyššie zdokumentované "nemáme interné Shoptet id"
  platilo (a stále platí) LEN pre `SHOPTET_ORDERS_URL`'s CSV export (67
  stĺpcov, `patternId=-9`) — ten ho naozaj vôbec nenesie. Existuje ale
  SAMOSTATNÝ XML export objednávok (`patternId=-11`, dovtedy len
  poznamenaný v pamäti appky "pre neskoršie fázy", nikdy neskúšaný), ktorý
  `<ORDER_ID>` NESIE, hneď pred objednávkovým `<CODE>` na KAŽDEJ objednávke
  (naživo overené: kód `20260897` → `ORDER_ID` `58656`). S TÝMTO id
  `/admin/objednavky-detail/?id=<id>` UŽ FUNGUJE — appka ho teraz sťahuje
  BEST-EFFORT vedľa CSV (`modules/orders/fetcher.ts`'s
  `createHttpOrderIdsFetcher` + `parser.ts`'s `extractOrderIdsFromXml`,
  nová nepovinná premenná `SHOPTET_ORDERS_XML_URL`) a ukladá do
  `order.shoptet_order_id` (migrácia 0016, `COALESCE`-ovaný refresh —
  chýbajúca premenná/zlyhaný fetch NIKDY nevynuluje predtým zistené id).
  `queries.ts`'s `buildShoptetAdminOrderUrl` použije priamy odkaz na detail,
  keď id pozná, inak padá späť na vyhľadávanie vyššie. Poučenie pre ĎALŠIE
  podobné "toto pole/možnosť Shoptet nemá" zistenie: over VŠETKY dostupné
  export FORMÁTY (appka mala v pamäti aj `orders.xml`/`productsComplete.xml`
  alternatívy, nikdy vyskúšané, lebo CSV dovtedy stačilo) predtým, než sa
  záver zovšeobecní na "Shoptet to nemá vôbec" — mal len iný, dovtedy
  neotestovaný export.
- **`fixtures/orders-sample.csv` je RUČNE vyrobená (nie výrez reálneho
  exportu ako katalógova fixtúra), takže sa smie prepísať CELÁ pythonom —
  žiadny byte-for-byte jeden-riadok postup ako `.claude/rules/catalog.md`
  vyžaduje pre katalógovú fixtúru.** Formát je ale nezvyčajný: KAŽDÉ pole je
  zacitované (`"code";"date";...`), ALE úplne posledný stĺpec (prázdny,
  vytvorený koncovou bodkočiarkou na riadku) je BEZ úvodzoviek — obyčajný
  `csv.writer(..., quoting=csv.QUOTE_ALL)` by ho namiesto toho zapísal ako
  `""`, čo sa rozíde od pôvodného tvaru (nekriticky pre parser, ale zbytočný
  šum v diffe). Bezpečný postup (issue 65, pridanie `remark` na order
  20300001): `csv.reader` (delimiter `;`, quotechar `"`) načíta všetky
  riadky, uprav cieľové polia, potom RUČNE zlož každý riadok
  (`";".join(esc(v) for v in row[:-1]) + ";"`, `esc` obaľuje úvodzovkami +
  zdvojuje vnútorné), NIE `csv.writer` nad celým súborom.
- **Kumulatívne hlásenie o neuložených zápisoch (issue 66) je
  `apps/web/src/ordersWriteFailures.ts`** — nahradilo pôvodný jediný
  `stateError` string v `OrdersSection.tsx` (každé ďalšie zlyhanie ho
  prepísalo, staršie zlyhanie zmizlo z obrazovky). Zoznam kľúčovaný `id =
  <akcia>:<cieľ>` (napr. `state:<lineId>`, `comment:<orderId>`,
  `groupOrdered:<supplier>`) — zhodné `id` NAHRADÍ starú položku (aktualizuje
  dôvod), cudzie `id` PRIDÁ nezávislú položku vedľa nej. KAŽDÁ ĎALŠIA nová
  zápisová akcia na tomto tabe (7. write handler) musí rovnako
  upsert/clear-núť VLASTNÝ `id` do `writeFailures`, nikdy nezaviesť nový
  samostatný `useState` error string vedľa neho — to by obnovilo presne ten
  istý "posledné zlyhanie prepíše predchádzajúce" bug pre tú JEDNU akciu.
  Žiadna optimistická reconciliation (legacy `app.js:1093-1240`'s
  commitSeq) tu nie je potrebná — `checked={line.ordered}`/`<select
  value={line.state}>` (`OrderLineRow.tsx`) sú viazané PRIAMO na
  server-potvrdenú hodnotu z props, takže zamietnutý zápis sa NIKDY netvári
  ako uložený už len vďaka existujúcemu dizajnu.
- **Pridanie ĎALŠIEHO poľa na `OpenOrderLine` (issue 164, `shopRemark` —
  interná poznámka e-shopu, export's stĺpec 28) je 3-krokový checklist,
  nielen "pridaj stĺpec":** (1) **SUROVÁ hodnota v DB, ODVODENÁ hodnota v
  API** — rovnaký vzor ako `internalNote` (surové) →
  `resolveEffectiveSupplierLink` (odvodené pri dopyte, issue 67/70): nový
  `order.shop_remark` stĺpec nesie presne to, čo prišlo z exportu (môže
  niesť aj appkin vlastný `note-block.ts` blok), `queries.ts` ho až PRI
  DOPYTE rozdelí (`extractForeignShopRemark`) na to, čo appka smie ukázať.
  Nikdy neuklad ODVODENÚ hodnotu priamo do DB — znemožnilo by to spätné
  odvodenie pri zmene formátu oddeľovačov. (2) **KAŽDÝ existujúci fixtúrový
  objekt `OrderLine` naprieč VŠETKÝMI test súbormi (17 pri issue 164, `grep
  -rl "manualSupplierOverride" apps/web/src`) potrebuje explicitné nové pole**
  — zavedená konvencia tohto repa je "každé pole sa nastavuje explicitne,
  nikdy sa nespolieha na `undefined`" (over: KAŽDÝ existujúci fixtúrový
  objekt už mal explicitný `remark:`, keď sa to pole pridávalo). Skript
  (Python regex vkladajúci nový riadok hneď za `remark: ...,` vo všetkých 17
  súboroch naraz) je rýchlejší než ručná úprava. (3) **Nová stĺpcovaná
  (stacked) položka v zlúčenej bunke "Poznámky" (`.ord-notes-merged`) RASTIE
  výšku riadku pre riadky, čo majú VŠETKY voliteľné poznámky naraz** —
  `apps/web/tests/e2e/orders-layout.spec.ts`'s "kompaktné riadky" strop
  (predtým 100px, ešte predtým z issue 105/107/111/127) treba pri PRIDANÍ
  ĎALŠEJ voliteľnej stĺpcovanej položky do tejto bunky prehodnotiť a
  ZMERAŤ naživo (nie odhadnúť) — issue 164 zdvihlo strop na 115px (namerané
  108.5px pri riadku so VŠETKÝMI tromi poznámkami naraz). Over VŽDY
  OSOBITNE, že to nie je návrat "vstup+tlačidlo sa zalomí na dva riadky"
  regresie (samostatná asercia `naTomIstomRiadku`, tá sa NEMENÍ) — len
  legitímny rast obsahu smie posunúť tento strop, nikdy zalomenie.
- **Issue 172 pridalo štyri nové objednávkové polia (`email`/`phone`/
  `package_number`/`shipping_carrier_name`) extrahované NEZÁVISLE od
  `mapOrderRow`'s item-validácie (`parser.ts`'s `extractOrderLevelExtra`/
  `mergeOrderLevelExtra`) — sú na KAŽDOM riadku objednávky vrátane pseudo-
  položiek, `shipping_carrier_name` je práve na SHIPPING pseudo-riadku,
  ktorý `mapOrderRow` inak celý zahodí. Na rozdiel od `status_name`/
  `remark`/`shop_remark` (priamo prepísané pri re-importe) sú tieto ŠTYRI
  polia COALESCE-ované ako `shoptet_order_id` — plné odôvodnenie a
  regresný test v `.claude/rules/posta-uncollected.md`.**
- **Issue 237 pridalo `order.total_price_with_vat` (celková suma s DPH,
  export's `totalPriceWithVat` stĺpec) — rovnaká rodina ako `status_name`/
  `remark`/`shop_remark` (VŽDY Shoptetovo pole, `mapOrderRow` berie prvý
  riadok na objednávku, `ingest.ts` ho pri re-importe PRIAMO prepisuje,
  nikdy COALESCE-uje). Parsuje sa zdieľaným `catalog/money.ts`'s
  `parseDecimalComma` (Shoptet-ova desatinná ČIARKA) — žiadna nová
  duplicitná money-parsovacia logika.**
- **Dashboard "Prehľad e-shopu" (issue 237, `orders/overview.ts`) je
  ZÁMERNE samostatný od "Na objednanie"'s zoznamu — číta PRIAMO `order`
  tabuľku (nie cez `order_line` JOIN), na rozdiel od
  `listOpenOrderLinesBySupplier`'s open-status filtra.** Dôvod: ide o
  celoobchodnú štatistiku (rovnakú, akú ukazuje Shoptet-ov vlastný
  dashboard), nie o dodávateľský pracovný zoznam — uzavretá ("Vybavená")
  objednávka sa preto MUSÍ zarátať rovnako ako otvorená
  (`orders-overview.integration.test.ts`'s dedikovaný test). **Jedna
  výnimka od issue 407 (pozri ďalší bod): "Stornovaná" sa NEZARÁTA.**
- **issue 407 (majiteľ: "tieto čísla mi nejako nesedia oproti shoptetu") —
  DVE opravy oproti pôvodnému (issue 237) dizajnu, obe naživo overené
  binárnym hľadaním hranice v produkčnej DB proti Shoptet-ovým reálnym
  číslam (plný dôkaz + presné SQL v issue 407's komentári):**
  1. **"Týždeň"/"Mesiac" sú KĹZAVÉ (rolling) okná, NIE kalendárne**
     (pôvodne pondelok tohto týždňa / 1. deň tohto mesiaca — appky
     pôvodné čísla PRESNE sedeli s kalendárnym výpočtom, kým Shoptet
     ukazoval iné, vyššie čísla). `now - 7 dní` / `now - 1 kalendárny
     mesiac` dali PRESNE Shoptetove čísla. **"Dnes" OSTÁVA kalendárny
     deň** — Shoptetova samostatná "24 hodín" dlaždica (iná hodnota než
     jeho "Dnes" v tom istom momente) to naživo dokazuje.
  2. **"Stornovaná" objednávky sa NEZARÁTAJÚ** (do počtu; na tržbu to v
     dnešných dátach nevplýva, keďže KAŽDÁ stornovaná objednávka má
     `total_price_with_vat = 0.00`, no filter je explicitný podľa
     `status_name`, nespolieha sa na túto zhodu — pozri
     `STORNO_STATUS_NAME` v `overview.ts`).
- **Hranice "dnes" (kalendárny deň)/"tento týždeň" (kĺzavých 7 dní)/"tento
  mesiac" (kĺzavý kalendárny mesiac) v Europe/Bratislava (`overview.ts`'s
  `computeOrdersDashboardBoundaries`, premenované z pôvodného
  `computeBratislavaPeriodBoundaries` v issue 407 — pôvodný názov už
  nesedel, keď dve z troch hraníc prestali byť "kalendárne Bratislava")
  ZNOVA POUŽÍVAJÚ `timezone.ts`'s zdieľanú `getZonedDateParts` +
  `parser.ts`'s `parseShopLocalDateTime`** (zostaví kandidátny
  `"YYYY-MM-DD HH:mm:ss"` miestny reťazec a nechá ho previesť už
  existujúcou, DST-otestovanou funkciou) — nikdy nereimplementuj tú istú
  UTC-konverznú offset aritmetiku druhýkrát. Prvý pokus autora TOTO
  pravidlo porušil (vlastná offset-počítacia funkcia LEN s dátumovými, nie
  časovými, `Intl.DateTimeFormat` poľami) a dal ŠPATNÝ výsledok — polnoc
  formátovaná cez date-only polia stratí celý hodinový posun zóny (viď
  dôkaz nižšie), odhalené AŽ pri ručnom prepočte cez `TZ=Europe/Bratislava
  date`, nie testom (test by len potvrdil vlastnú chybnú implementáciu).
  **"Mesiac" (issue 407, `subtractOneMonthClamped`) MUSÍ počítať v
  MIESTNOM (Bratislava) kalendári, nie v UTC** — code review na issue 407
  chytilo prvý pokus autora, ktorý počítal cez `date.getUTC*()`: keďže
  "teraz" a cieľový mesiac môžu mať ROZDIELNY DST offset (napr. "teraz" v
  marci = CEST +2, cieľový február = CET +1), UTC-only výpočet by ~1-2
  hodiny denne (okolo miestnej polnoci, keď sa UTC deň/mesiac líši od
  miestneho) odvodil hranicu zo ŠPATNÉHO kalendárneho dňa — presne to
  isté, kvôli čomu bol pridaný `getZonedDateParts` na "dnes". Regresný
  test (`overview.test.ts`) overuje presne tento prípad (31.8. 22:30 UTC =
  1.9. 00:30 CEST — UTC mesiac (august) sa líši od miestneho (september)).
  Súčet peňazí (`sumMoneyCents`) beží cez BigInt centy, nikdy cez `number`
  — rovnaká disciplína ako `catalog/money.ts`.
- **`subtractOneMonthClamped` CLAMPuje na posledný deň cieľového mesiaca
  (rovnaké správanie ako Postgres-ov `timestamp - interval '1 month'`,
  overené priamo v produkčnej DB: `date '2026-03-31' - interval '1 month'`
  = `2026-02-28`, NIE prepad do marca ako by dal holý JS
  `setUTCMonth`/`setMonth`)** — naživo overené AJ ako jediná definícia, čo
  presne reprodukuje Shoptetove čísla (fixných "posledných 30 dní" bolo
  priamo v DB vyvrátené: v 31-dňovom mesiaci dáva iné číslo, než Shoptet
  skutočne ukazuje).
- **Test na KAŽDÝ ĎALŠÍ "naivný lokálny čas → UTC" výpočet v tomto module:
  over HODNOTU (nie len že kód "vyzerá správne") ručným prepočtom
  `date -u -d @$(TZ=Europe/Bratislava date -d "<Y-M-D> 00:00:00" +%s)
  +"%Y-%m-%dT%H:%M:%SZ"` PRED napísaním testu s očakávanou hodnotou** —
  inak test len potvrdí to, čo kód práve robí, aj keby to bolo o hodinu
  posunuté. Konkrétny nájdený omyl (opravený pred commitom): pre "dnes" =
  2026-08-04 (utorok) autor najprv napísal test očakávajúci, že "týždeň"
  (pondelok toho istého týždňa, 2026-08-03) dá TEN ISTÝ UTC okamih ako
  "dnes" — nesprávne, sú to DVA rôzne kalendárne dni, teda dva rôzne
  okamihy (`2026-08-02T22:00:00Z`, nie `2026-08-03T22:00:00Z`).
- **Pre "1 kalendárny mesiac dozadu"/clamp-ové prípady (issue 407,
  `subtractOneMonthClamped`) holý `date -d "1 month ago"` NESTAČÍ na
  ručné overenie — GNU `date`'s vlastná mesačná aritmetika sa nespráva
  rovnako ako Postgresov `interval '1 month'` clamp (`31.3. - 1 mesiac`
  môže GNU date-om vyjsť inak než `28.2.`).** Presnejší postup: throwaway
  `node -e` skript, čo verne skopíruje SKUTOČNÚ implementáciu
  (`getZonedDateParts`/`parseShopLocalDateTime`/`subtractOneMonthClamped`
  inline) a vytlačí `.toISOString()` pre kandidátne `now` hodnoty PRED
  napísaním testu s očakávanou hodnotou — presne tak sa odhalilo, že
  clamp-testy cez DST hranicu (marec CEST → február CET) musia dať iný
  UTC čas (`T11:00:00Z`), než mechanické zachovanie tej istej UTC hodiny
  hodiny (`T10:00:00Z`) by naznačovalo. Rovnaký princíp ako existujúci
  `date -u -d @$(...)` trik vyššie, len pre prípady, kde jednoduchý shell
  `date` výpočet nevie verne reprodukovať vlastnú clamp/DST logiku appky.
- **Slovenské skloňovanie POČTU objednávok potrebuje TROJTVAROVÝ (paucal)
  pomocník, nie holé "N objednávok".** Code review PR #244 (issue 237):
  `OrdersOverviewTiles.tsx` pôvodne vypisovala vždy "N objednávok", čo je
  gramaticky zle pre 1 ("objednávka") a 2-4 ("objednávky"). Fix:
  `apps/web/src/ordersSummary.ts`'s `formatOrderCount` — priamy náprotivok
  `apps/api/src/modules/orders/ingest.ts`'s (neexportovanej) `formatCount`
  (1 → jednotné číslo, 2-4 → málopočetné, 0/5+ vrátane 22/23/24… → rodový
  pád množného čísla, slovenčina neodvodzuje tvar z poslednej číslice na
  rozdiel od ruštiny/poľštiny). KAŽDÝ ĎALŠÍ text, čo appka skloňuje priamo
  v UI (nie len spolu s neutrálnou jednotkou ako `formatVariantTotalChip`'s
  "N ks"), potrebuje rovnaký trojtvarový pomocník, nikdy šablónový
  reťazec s jedným pevným tvarom podstatného mena.

- **`summarizeOrderLines` (`ordersSummary.ts`) doteraz počítala RIADKY
  (`lines.length`, `+= 1`), nie sčítanú `quantity` — ticho podčítala presne
  vtedy, keď `ingest.ts` sčíta ten istý produkt v tej istej objednávke do
  JEDNÉHO riadku s `quantity > 1` (issue 260, majiteľ: "sú tam 2 rovnaké
  čelovky, ale ukazuje len jednu").** Fix: KAŽDÉ pole
  (`total`/`remaining`/`ordered`/`waiting`/`stock`/`unavailable`) sčítava
  `line.quantity`. **Výnimka, ktorú treba poznať pred ĎALŠOU zmenou tejto
  funkcie:** `OrdersSection.tsx`'s nav-odznak (issue 147,
  `OrdersRemainingCountContext`) má VLASTNÝ, samostatne testovaný zámer —
  "počet NEVYBAVENÝCH RIADKOV" (test explicitne hovorí "nie celkový
  počet") — preto NEJDE cez `summarizeOrderLines(...).remaining`, ale počíta
  priamo `allLines.filter((l) => !isLineResolved(l)).length`. Test na
  KAŽDÚ ĎALŠIU zmenu tejto funkcie: potrebuje niektoré volajúce miesto
  POČET RIADKOV namiesto súčtu kusov? Ak áno, nech si to počíta samo cez
  `isLineResolved`, nespoliehaj sa na to, že `summarizeOrderLines` uhádne
  správny význam pre všetkých volajúcich naraz.
- **"Zlúčenie objednávok" (issue 257, `modules/orders/merge-mail.ts`'s
  `listMergeCandidateGroups`) číta VÝHRADNE tabuľku `orders` (`customer
  IdentityKey` = e-mail orezaný/malé písmená, fallback na meno) — ŽIADEN
  JOIN na `order_line`.** Dôsledok pre e2e fixtúry: dve otvorené objednávky
  toho istého (fiktívneho) zákazníka sa dajú seedovať BEZ jediného
  `order_line` riadku (`scripts/e2e-setup.ts`'s objednávky "9010"/"9011") —
  nulové riziko rozbitia presných počtov v dodávateľských zoskupeniach,
  ktoré `orders.spec.ts` overuje (`.claude/rules/testing.md`'s "nový
  fixtúrový variant sa nesmie vybrať len podľa 'je nepoužitý'" pravidlo sa
  tu vôbec netýka — žiadny variant sa nepoužíva). Test pre KAŽDÚ ĎALŠIU
  funkciu, ktorá potrebuje len OBJEDNÁVKOVÚ (nie riadkovú) identitu: over,
  či fixtúra skutočne potrebuje `order_line`, predtým než ho pridáš —
  zbytočný riadok len zväčšuje riziko kolízie s existujúcimi presnými
  počtami.
- **Zoznam kariet kľúčovaný podľa SKUPINY (nie podľa jednej objednávky) si
  `data-testid` vyberá z NAJNOVŠEJ objednávky skupiny, podľa jej VIDITEĽNÉHO
  Shoptet čísla (`externalOrderId`), NIE podľa interného DB `orderId`
  (UUID).** `OrderMergeSection.tsx`: `group.orders[0]` je po zoradení
  najnovšia objednávka (rovnaké poradie ako `listMergeableOrders`), jej
  `externalOrderId` je stabilné a čitateľné aj v e2e teste napísanom PRED
  behom (UUID sa dozvieš až za behu). Rovnaký zámer ako
  `NedostupneSection.tsx`'s `variantCode`-kľúčované testid.
- **issue 277: "Zlúčenie objednávok" zdieľa `MailPreviewDialog.tsx`'s
  editovateľné telo (`bodyText`/`onBodyTextChange`, `editedBody` na
  `/send`) s "Nedostupné tovary" — plné odôvodnenie (prečo textarea a
  nie rich-text, `renderEditedBody`, `toHaveValue()` namiesto
  `toContainText()` na kontajneri s textarea vo vnútri) je zdokumentované
  v `.claude/rules/nedostupne.md`, aby sa nemuselo písať dvakrát. `sendOrderMergeMail`'s nový voliteľný `editedBody` má rovnaký tvar
  (`{ ...built.content, ...renderEditedBody(editedBody) }`, predmet
  ostáva pôvodný).
- **issue 276: kód produktu POD číslom objednávky, prelinkovaný na náš eshop
  (`OpenOrderLine.ourUrl`), je TRETÍ spotrebiteľ toho istého vzoru, aký
  založilo issue 238 na "Nedostupné tovary" (`nedostupne/queries.ts`'s
  `ourProductUrl`) — LEFT JOIN `shop_product_url` podľa kódu variantu
  (nikdy INNER — chýbajúci feed riadok nesmie vyradiť riadok zo zoznamu),
  `<a>` len keď adresu poznáme, inak plain text. **Zámerne NEPOUŽÍVA
  `shopLinks.ts`'s `ourProductLink()`** (vyhľadávací fallback, ktorý
  používa `RestockSection.tsx`) — majiteľova podmienka pre TENTO obrazovka
  je opačná: neznáma adresa = neaktívny text, nikdy odkaz na vyhľadávanie.
  Keďže `shop_product_url` je kľúčovaná LEN kódom variantu (nie
  objednávkou), VŠETKY riadky zdieľajúce ten istý `variantCode` naprieč
  RÔZNYMI objednávkami dostanú TÚ ISTÚ `ourUrl` hodnotu — to sa využilo aj
  v teste (`orders.spec.ts`): fixtúrový variant "40287" má (kvôli inému,
  staršiemu "Nedostupné tovary" testu, issue 238) už seedovaný
  `shop_product_url` riadok, takže objednávka 9002 nad tým istým variantom
  dostala kód-odkaz "zadarmo", bez potreby novej fixtúry.
- **Ceiling test PASSING (`orders-layout.spec.ts`'s 105px) after adding an
  ALWAYS-rendered second line to a cell is NOT the same proof as "row height
  didn't change" — code review on issue 276 caught this distinction.**
  `.ord-code-cell` (kód produktu POD číslom objednávky) renderuje sa na
  KAŽDOM riadku (variant kód je vždy prítomný), na rozdiel od `.ord-remark-
  cell`'s voliteľného `remark` — takže "strop 105px prešiel" samo osebe
  dokazuje len HORNÚ hranicu, nie že sa PRIEMERNÁ výška riadku nezvýšila (ten
  istý strop by prešiel aj pri systematickom náraste, napr. 55px→78px).
  **Skutočný dôkaz "nula zmena" bol PÁROVÉ meranie** (rovnaká myšlienka ako
  živé `page.addStyleTag` kandidáty z issue 105/107/111/127/164, len BEZ
  potreby produkcie): `page.evaluate` najprv zmeria `getBoundingClientRect
  ().height` VŠETKÝCH `.order-row`, potom vloží `<style>.ord-code-cell{
  display:none!important}</style>` (simuluje "pred zmenou" stav BEZ
  akéhokoľvek redeploy/revert) a zmeria ZNOVA — obe sady čísel boli PRE
  KAŽDÝ RIADOK bajt-na-bajt zhodné, na VŠETKÝCH 4 šírkach, na OBOCH
  fixtúrových sadách (izolovaný `E2E_ROZLOZENIE_EMAIL` účet aj globálny
  `E2E_FILTRE_EMAIL` s 8 riadkami DODAVATEL-TEST-1/"(bez dodávateľa)").
  Príčina: `.ord-order-cell`'s pridaná výška (jeden `--fs-text-xs` riadok +
  `--fs-space-1` margin, ~16-20px) ostáva pod výškou, ktorú riadku už aj tak
  vynucujú iné bunky (stavové tlačidlá `.ord-state-btn-group`, `.ord-qty-
  stack`) — najnižšia nameraná výška riadku dnes (85px pri 1920px) má
  bezpečnú rezervu nad `.ord-order-cell`'s samostatnou výškou. **Test na
  KAŽDÝ ĎALŠÍ vždy-viditeľný (nie podmienene renderovaný) druhý riadok v
  tejto tabuľke:** nestačí, že existujúci ceiling test prešiel — spusti
  párové pred/po meranie (dočasná inštrumentácia spec súboru, revert pred
  commitom, presne tento vzor) a over, že žiadny riadok skutočne NEROSTIE,
  nielen že žiadny neprekročil strop.
- **Issue 269: `ingestOrders`'s DB transakcia (po upsert-e `order` riadkov,
  pred XML-backfill krokom) teraz NAVYŠE volá zdieľanú `upsertUpozornenie()`
  (`.claude/rules/upozornenia.md`) pre KAŽDÚ objednávku, ktorej `statusName`
  je jeden zo živo overených vrátkových stavov (`orders/return-status.ts`).**
  Plné odôvodnenie (dedup na objednávku nie na pod-stav, prečo sa karta
  nikdy nezatvára automaticky) je v `upozornenia.md`, aby sa nepísalo
  dvakrát. Pre KAŽDÝ ĎALŠÍ nový stĺpec/pole odvodené z `order.status_name`
  vnútri tejto transakcie: pamätaj, že `orderInfo` (a teda aj tento hák) je
  naplnené LEN pre objednávky, čo majú aspoň JEDEN skutočný produktový
  riadok (nie len pseudo-položky) — rovnaké obmedzenie, aké má celý
  `order` upsert vyššie, nie nová medzera zavedená týmto tiketom.
  Integračné testy pre CSV-riadené vrátkové stavy s diakritikou
  (`orders-ingest-return-upozornenie.integration.test.ts`) potrebujú
  SKUTOČNÉ cp1250 bajty (appka vždy dekóduje `decodeCp1250`) — súbor si
  stavia kódovaciu tabuľku DYNAMICKY (dekóduje všetkých 256 bajtov cez
  `TextDecoder("windows-1250")` a obráti mapu), namiesto ručne písanej
  tabuľky kódových bodov alebo novej závislosti (`iconv-lite`).
- **Issue 301: TA ISTÁ transakcia navyše volá `applyStuckUpozornenia`
  (`orders/stuck-upozornenia.ts`) hneď VEDĽA `applyReturnUpozornenia` — karta
  na objednávku, čo dlho visí v nevybavenom stave ("Vybavuje sa"/
  "Nevybavená", `orders/stuck-status.ts`).** Plné odôvodnenie (prah 14 dní
  vs. `order-reminder`'s 4-dňový, prečo je táto kategória ZNOVA-OHLÁSITEĽNÁ
  na rozdiel od `vratenie`'s KONEČNEJ, dávkovaný auto-resolve pre-check bez
  `.for("update")`) je v `.claude/rules/upozornenia.md`, aby sa nepísalo
  dvakrát. Testovací vzor (vlastný `rowOf` s nastaviteľným `date` stĺpcom,
  cp1250 cez zdieľané `helpers/orders-return-csv.ts`) je v
  `orders-ingest-stuck-upozornenie.integration.test.ts` — rovnaký dôvod na
  cp1250 ako vyššie (stav "Nevybavená" nesie diakritiku).
- **Issue 345: "Eshop → Objednávky predajňa" — predajňové objednávky sa
  rozlišujú cez `order.shipping_carrier_name ILIKE '%Osobný odber%'`
  (PODREŤAZEC, nikdy presná veta s výkričníkom — Shoptet ju môže kedykoľvek
  preformulovať, `floor-orders-queries.ts`). Zistené naživo na produkcii
  (ticket, komentár 11.8.2026): `shipping_carrier_name` = "Osobný odber -
  len na predajni v POPRADE!" (30→32 objednávok), sedí aj s
  `payment_method_name` = "V hotovosti", ale TÚTO druhú koreláciu appka
  zámerne NEVYUŽÍVA ako filter (nespoľahlivá, len doplnková zhoda z
  komentára na tickete). Táto obrazovka je jednotabuľkový WHERE+ORDER BY
  bez per-riadkového odvodenia — na rozdiel od `order-flags-queries.ts`
  (load-everything + JS filter, lebo potrebuje `unresolved`) tu je preto
  správne skutočné SQL `LIMIT`/`OFFSET` + `COUNT(*)`, rovnaký vzor ako
  `catalog/queries.ts`'s `searchVariants`. `PAGE_SIZE = 10` (zámerne malé,
  nie zvyčajných 50) — produkcia má len ~30 zodpovedajúcich objednávok,
  malá strana robí "Načítať ďalšie" reálne overiteľné aj naživo. Review
  finding: `ORDER BY placed_at DESC` SAMOTNÉ je nedeterministické pri
  dvoch objednávkach v tej istej minúte (Shoptet `date` má len minútovú
  presnosť) — `.orderBy(desc(orders.placedAt), desc(orders.id))` je
  tie-breaker, rovnaký vzor ako `catalog/queries.ts`'s
  `desc(fetchedAt), desc(id)`. Test na KAŽDÝ ĎALŠÍ nový `ORDER BY placedAt`
  dopyt s LIMIT/OFFSET: pridaj rovnaký tie-breaker, inak stránkovanie môže
  riadok zopakovať alebo stratiť pri zhode timestampu.
- **Issue 412: `ingestOrders` teraz `order_line` riadky AJ MAŽE, nielen
  INSERTuje/UPDATEuje — zosúladenie s aktuálnym exportom, keď Shoptet
  vymení/odstráni produkt na už prijatej objednávke.** Predtým: upsert
  keyed na `(order_id, variant_code)` NOVÝ produkt vždy pridal (INSERT
  vetva ON CONFLICT), ale STARÝ riadok, ktorého dvojica z novšieho
  exportu zmizla, navždy zostal v DB — presne bug #412 (objednávka
  20261306 stále ukazovala dávno vymenenú "Flisová bunda Percussion
  Scotland"). Fix: po existujúcom upsert cykle, pre KAŽDÚ objednávku,
  ktorú TENTO beh spracoval (`orderIdByExternalId`), zmaž `order_line`
  riadky, ktorých `variant_code` NIE JE medzi kľúčmi
  `lineTotals.get(externalOrderId)` — surová množina variantov, ČO
  TENTO EXPORT hlási, PRED filtrom na "známy variant v katalógu" (inak
  by sa mohol zmazať legitímny existujúci riadok len preto, že
  katalógové overenie preň v TOMTO JEDNOM behu zlyhalo). Riadky
  objednávok MIMO tohto behu (staršie než okno, objednávka bez
  jediného reálneho produktu v tomto behu) sa vôbec nedotýkajú.
  Dávkovaný set-based DELETE cez `chunk()` (rovnaký vzor ako zvyšok
  súboru), postavený VÝHRADNE z existujúceho drizzle query builderu
  (`and`/`or`/`notInArray`) — žiadny nový raw-SQL VALUES trik (review
  finding, issue 412 — vyhol sa tomuto zámerne, viď `\s`-escape past
  vyššie v tomto súbore aj v `.claude/rules/database.md`).
  **FK prieskum (design komentár na tickete, over pred KAŽDOU ďalšou
  zmenou tejto oblasti, ktorá by chcela `order_line` mazať/nahrádzať):
  NIČ v appke nemá cudzí kľúč na `order_line.id` ani na dvojicu
  (order_id, variant_code)** — `order_reminder_state` (kľúč
  `order_code`), `dpd_shipment` (kľúč `order_id`),
  `product_supplier_override`/`product_supplier_link_override` (kľúč
  `product_key`) a Zlúčenie objednávok (číta LEN `order`) prežijú
  zmazanie bez zmeny; `audit_events.entity_id` je prostý text bez FK;
  frontendov `lineId` je len dočasný React stav, súbežný zápis na
  medzičasom zmazaný riadok narazí na už existujúcu "not_found" vetvu
  (`state.ts`). **Poradie zamykania:** táto DELETE (rovnako ako
  existujúci `order_line` upsert PRED ňou) drží `order` riadky
  zamknuté z hlavného upsertu a POTOM zamyká `order_line` — teoreticky
  sa to môže stretnúť s `setSupplierLinesOrdered`'s `.for("update", {
  of: [orderLines, orders] })` v OPAČNOM poradí (AB-BA cyklus,
  Postgres deadlock detektor to bezpečne vyrieši, žiadna korupcia).
  Toto NIE JE nová trieda rizika (appka ju má už roky cez existujúci
  upsert) — vyhradený deterministický regresný test tejto interakcie
  (rovnaká technika ako `orders-supplier-bulk-lock.integration.test.ts`)
  je samostatný ticket #416, mimo rozsahu #412.

- **Identita zákazníka ("ten istý zákazník naprieč objednávkami") žije v
  JEDNOM zdieľanom module `modules/orders/customer-identity.ts`
  (`customerIdentityKey(email, customerName)`: `email:<trim/lower>`, inak
  fallback `name:<trim/lower>` — zákaznícke id v schéme NEEXISTUJE) —
  používa ho `merge-mail.ts` (záložka Zlúčenie objednávok, #257) aj
  `queries.ts`'s odznak počtu otvorených objednávok v "Na objednanie" (#431,
  `countOpenOrdersByCustomer` + `customerOpenOrderCount` na riadku).
  KAŽDÁ ďalšia funkcia, čo počíta "ten istý zákazník", MUSÍ znovupoužiť
  TENTO kľúč — inak sa odznak ("zváž zlúčenie") a samotné zlúčenie rozídu.
  "Otvorená objednávka" = `order.status_name ∈ order_open_status`
  (default "Vybavuje sa"; `open-statuses.ts`) — Stornovaná/Vybavená sa nikde
  nepočítajú.
- **Odznak (`.cust-order-badge`, `CustomerOrderCountBadge.tsx`) sa zobrazuje
  LEN pri počte ≥ 2** a `title` == `aria-label`, skloňované podľa počtu
  (2-4 → "otvorené objednávky", 5+ → "otvorených objednávok" — tá istá 2-4/5+
  hranica ako `ordersSummary.ts`'s `formatOrderCount`). Pozor: keď sa pridá
  NOVÉ povinné pole na `OrderLine`, doplň ho do VŠETKÝCH fixtúr (typovaných
  aj NETYPOVANÝCH cez `vi.fn()` mocky — `grep -rl manualSupplierOverride
  apps/web/src`), inak netypovaná fixtúra nesie `undefined` a napr.
  `undefined < 2` je `false`, takže odznak sa VYKRESLÍ s textom "undefined"
  (pravidlo "každé pole explicitne, nikdy undefined" vyššie v tomto súbore).
- **Sekcia „Riešiť" (issue 476, piaty EXKLUZÍVNY stav `riesit`, princíp
  `nedostupne`) znovupoužíva jadro „Na objednanie" cez zdieľaný hook
  `apps/web/src/useOrderLinesBoard.ts` — NIE cez kópiu OrdersSection.** Hook
  nesie `suppliers` + všetky mutácie (stav/objednané/priradenie/odkaz/poznámka/
  hromadné) + sub-hooky (drafts, dirtyEditors, email, mail, supplier-link).
  OrdersSection aj RiesitSection ho konzumujú; OrdersSection správanie ostalo
  1:1 (`keepOnlyState` undefined → pôvodný optimistický map; `onStateChanged`
  no-op default). RiesitSection posiela `keepOnlyState:"riesit"` (riadok pri
  zmene stavu na iný sa lokálne odstráni) + vlastné rýchle pole. **Backend:**
  `listOpenOrderLinesBySupplier(db, adminBaseUrl, { stateFilter })` (NEduplikuje
  query), `countOpenOrdersByState` (issue 484: pôvodne `countOpenOrderLinesByState`),
  `setOrderLinesStateByCode` (bulk podľa
  `externalOrderId`); trasy `GET /api/orders/riesit(/count)`, `POST /riesit/
  by-code` — VŠETKY PRED `GET /api/orders/:id` (literal-pred-`:param`).
  `by-code` vracia 200 `{ok:false,error}` pri neznámom/zatvorenom čísle (NIE 4xx
  — konzola, `.claude/rules/testing.md`). Menu odznak `riesit` vzor issue 473.
  KAŽDÁ ďalšia „obrazovka nad podmnožinou otvorených objednávok" nech použije
  `useOrderLinesBoard` + `stateFilter`, nie novú kópiu.
- **Sekcia „Riešiť" ZJEDNODUŠENÁ (issue 484, Štěpán): NEskupuje po dodávateľoch —
  je to PLOCHÝ zoznam OBJEDNÁVOK.** `RiesitSection` už NErenderuje
  `board.suppliers.map(SupplierOrderGroup)`; namiesto toho `groupRiesitLinesByOrder`
  (`apps/web/src/riesitOrders.ts`) preskupí `board.suppliers[].lines[]` (NAPRIEČ
  dodávateľmi — jedna objednávka môže mať riadky u viacerých) podľa `orderId` do
  plochého zoznamu, najnovšia prvá. 1 objednávka = 1 kompaktný `RiesitOrderRow`
  (šípka ▾ · číslo objednávky preklik na `adminUrl` · zákazník · `formatItemCount`
  „N položiek" · dátum · poznámka); rozrolovanie ukáže PLNÉ položkové riadky
  (znovupoužitý `OrderLineRow`, `supplierBusy={false}`, `variantTotal` per-objednávka).
  Vypnutie stavu Riešiť POSLEDNEJ položky objednávku z odvodeného zoznamu zloží
  (`keepOnlyState:"riesit"` odstráni riadok z boardu → `groupRiesitLinesByOrder`
  ju už nevytvorí). **Nav odznak `riesit` počíta DISTINCT OBJEDNÁVKY** (nie riadky):
  `countOpenOrdersByState` = `countDistinct(order_line.order_id)` (drizzle `countDistinct`).
  `colgroup`+`thead` 9-stĺpcovej tabuľky sú vyčlenené do `OrderLinesTableHead`
  (jeden zdroj pravdy, zdieľaný `SupplierOrderGroup` AJ rozrolovaním Riešiť — DOM
  bajt-identický, „Na objednanie" testy nezmenené). Rýchle pole `by-code` bezo zmeny.
- **NAMING TRAP — v appke sú TRI/ŠTYRI rôzne „objednané"-podobné pojmy, NIKDY ich
  nezamieňaj (issue 493, Štěpán binding rozhodnutie 5423135473).** Po pridaní 6.
  stavu enumu existujú súčasne: **(a)** enum hodnota `objednane` = DEFAULT stav
  riadku, vo frontende label **„Nevybavené"** (issue 60 — NIE „Objednané"!);
  **(b)** enum hodnota `objednane_stav` = 6. EXKLUZÍVNY stav, label **„Objednané"**
  (issue 493, stav PRODUKTU — princíp `riesit`/`nedostupne`); **(c)**
  `order_line.ordered` boolean = ✓ checkbox „vybavil som akýmkoľvek spôsobom"
  (NEZÁVISLÝ od stavu — issue 60); **(d)** súhrnný chip „Objednané" v „Súhrn o
  objednávaní" (`ordersSummary.ts`'s `BREAKDOWN_PARTS`) počíta `ordered` BOOLEAN,
  nie stav. Preto interná hodnota nového stavu MUSÍ byť `objednane_stav`, NIKDY
  `objednane` (kolízia s defaultom + `ordered` toky). **Pridanie 6. stavu = presne
  vzor issue 476 (`riesit`), 5 miest:** (1) `schema-orders.ts`'s `orderLineState`
  pgEnum + samostatná migrácia `ALTER TYPE ... ADD VALUE 'objednane_stav'` (BEZ DDL
  použitia hodnoty → bezpečný vzor issue 476, žiadna 55P04, `database.md`); (2)
  `apps/web/src/ordersApi.ts`'s `orderLineSchema.state` z.enum — RUČNE zrkadlí
  enum (NIE odvodené!), bez nej frontend zod-odmietne každý riadok v novom stave
  A `OrderLine["state"]` typ ho nepozná; (3) `orderLineStateLabels.ts` —
  `STATE_LABELS` (Record, tsc vynúti) + `STATE_DISPLAY_ORDER` (exhaustive typ
  vynúti; nový stav na KONIEC = dolný rad, 3-stĺpcová grid mriežka spadne 3+3);
  (4) `app.css` — `.ord-state-btn-<hodnota>.active` farba (nový distinct odtieň,
  všetkých 5 sémantických rodín obsadených → `--fs-accent` fialová); (5) testy.
  Route `POST /api/orders/lines/:id/state`, stavové labely v hlavičke skupiny,
  rozbalené riadky v Riešiť aj `isLineResolved` (`state !== "objednane"`) berú nový
  stav AUTOMATICKY. Klient výslovne NEŽIADAL vlastnú sekciu (na rozdiel od Riešiť)
  — len tlačidlo + stav; `ordered`-boolean toky (hromadné označenie, Skryť
  vybavené, súčty, supplier e-mail) sa NEMENIA.
