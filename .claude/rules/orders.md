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
