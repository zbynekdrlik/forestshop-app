---
paths:
  - "apps/api/src/modules/supplier-stock/**"
  - "apps/api/src/modules/restock/**"
  - "apps/api/src/http/supplier-stock-routes.ts"
  - "apps/api/src/http/restock-routes.ts"
  - "apps/web/src/supplierStockApi.ts"
  - "apps/web/src/restockApi.ts"
  - "apps/web/src/components/SupplierStockSection*.tsx"
  - "apps/web/src/components/RestockSection*.tsx"
  - "apps/api/tests/supplier-stock-*.test.ts"
  - "apps/api/tests/restock-*.test.ts"
---

# Dodávateľský sklad a prepínanie Vypredané → Skladom (issues 212, 213)

- **`detailOnly` má ROVNAKÝ `variant.state` ako bežné vypredané — vylúčiť sa
  dá JEDINE cez `variant.product_visibility`.** `HIDDEN_VISIBILITIES`
  (`catalog/availability.ts`) `detailOnly` zámerne NEobsahuje (taký produkt sa
  dá kúpiť cez priamy odkaz, nie je to „ukončený predaj"). Zmerané na
  produkcii pri nasadení #213: 25 variantov `detailOnly` spĺňalo VŠETKY
  ostatné podmienky prepnutia a vylúčila ich jedine kontrola
  `product_visibility = 'visible'` — bez nej by sa zapli. Každá ďalšia
  automatizácia, ktorá niečo ZAPÍNA, potrebuje tú istú podmienku; `state`
  sám nestačí.
- **`supplier_stock.confirmed_at` je NIEČO INÉ než `checked_at` a
  automatizácia sa smie pozerať LEN naň.** `checked_at` je čas posledného
  POKUSU (aj neúspešného) a riadi preskakovanie čerstvých odkazov;
  `confirmed_at` je čas posledného ÚSPEŠNÉHO určenia dostupnosti. Keby sa
  čerstvosť potvrdenia merala podľa `checked_at`, opakovane zlyhávajúca
  kontrola by donekonečna predlžovala platnosť dávno neaktuálneho „skladom".
  Z rovnakého dôvodu zlyhaná kontrola `confirmed_at` NEPREPÍŠE na `null` —
  staré potvrdenie má dožiť svojich 48 h, nie zmiznúť pri prvom výpadku siete.
- **`unknown` (stránka sa načítala, ale nič sa z nej nedalo vyčítať) NIE JE
  chýbajúci údaj, ale plnohodnotná odpoveď — a nikdy nesmie nič prepnúť.**
  Majiteľ 3. 8. 2026 výslovne zamietol AI dohady (stará appka posielala
  nečitateľné stránky do OpenAI): čo sa nedá prečítať strojovo, sa ukáže v
  karte „Stránky, ktoré neviem prečítať" a čaká na ľudské rozhodnutie.
- **Voľnému textu stránky sa dôveruje LEN na doménach v `TEXT_AVAILABILITY_RULES`
  (`parse.ts`) — a LEN na VÝREZE, ktorý pravidlo označí za oblasť TOHTO
  produktu, nikdy na celej stránke (issue 223).** Pôvodný plochý zoznam
  `TRUSTED_TEXT_HOSTS` (`constants.ts`) bol ODSTRÁNENÝ — dôveroval CELEJ
  stránke, takže marketingová veta v pätičke huntingshop.eu ("…máme skladom
  ihneď k odberu.", na KAŽDEJ stránke obchodu) robila z každého produktu bez
  výslovného záporu `available`. Nové pravidlo nesie aj VÝREZ (regulárny
  výraz, ktorý vyberie oblasť dostupnosti PRI produkte — pre huntingshop.eu
  detailný `badge-outline-…` štítok BEZ `badge-stock`, ktorý patrí karuselu
  súvisiacich produktov) aj to, čo znamená CHÝBAJÚCI výrez (pre
  huntingshop.eu `unavailable` — produkt bez štítku dostupný nie je).
  Domény predtým v `TRUSTED_TEXT_HOSTS` bez vlastného overeného výrezu
  (`wetland.sk`, `trigona.sk`) touto zmenou STRATILI textovú úroveň úplne a
  končia na `unknown`, kým sa pre ne nenájde a neoverí vlastný výrez —
  zámerný, dokumentovaný ústup, nie chyba.
- **JSON-LD vie KLAMAŤ — na doménach v `VISIBLE_AVAILABILITY_RULES` (`parse.ts`)
  sa krížovo overuje proti viditeľnej dostupnosti PRI produkte (issue 225).**
  odimon.sk hlási v JSON-LD `InStock`, hoci viditeľný prvok
  `.product-availability__value` pri produkte hovorí "Nedostupný". Keď sa obe
  dajú prečítať a NESÚHLASIA, výsledok je `unknown` (stránka si protirečí,
  rozhoduje človek) — nikdy sa nevyhlási `available` na takomto rozpore. Prvý
  výskyt takého prvku v dokumente patrí hlavnému produktu — rovnaká trieda sa
  môže opakovať aj pri súvisiacich produktoch nižšie na stránke.
- **Obe polia dostupnosti sa do Shoptetu zapisujú NARAZ, ale `stock` sa
  nezapisuje VÔBEC (issue 219).** Shoptet zobrazuje `availabilityOutOfStock`,
  keď sklad klesne na nulu (overené v ostrej prevádzke starej appky
  14. 7. 2026), a v tomto obchode je zásoba trvalo nulová — majiteľ skladovú
  logistiku nepoužíva. Preto sa musia nastaviť OBA texty (inak zákazníkovi
  svieti staré „Vypredané"), zatiaľ čo zápis fiktívnej zásoby by do obchodu
  vpísal číslo, ktoré nikto neudržiava. Pôvodné pravidlo hovorilo opak
  („preto aj kladný `stock`") — bolo postavené na predpoklade, že zásoba
  niečo znamená.
- **Nová cesta zápisu CSV do Shoptetu patrí do `shoptet-writeback/csv.ts`, aj
  keď má úplne iné stĺpce** (`buildRestockCsv` vedľa `buildWritebackCsv`) —
  ochrana proti CSV injection (`dataRowToLine`) musí platiť pre KAŽDÚ cestu,
  nikdy sa stĺpce neskladajú mimo tohto modulu.
- **Shoptet export NEMÁ stĺpec s adresou produktu a `guid` je UUID — ale adresa
  sa NEODVODZUJE, BERIE sa z feedu pre porovnávače.** Pôvodné znenie tohto
  pravidla končilo tým, že jedinou cestou je vyhľadávanie podľa kódu
  (`https://www.forestshop.sk/vyhladavanie/?string=<code>`); to platilo len
  dovtedy, kým sa nenašiel zdroj adresy. Od issue 220 ju dodáva
  `https://www.forestshop.sk/google.xml` (podrobne v `.claude/rules/
  shop-feed.md`) a vyhľadávanie ostáva len ako NÁHRADA pre 626 viditeľných
  variantov, ktoré vo feede nie sú. Slovenská cesta `/vyhladavanie/` naďalej
  platí — česká `/vyhledavani/` na tejto doméne vracia 404.
- **Zoznam, podľa ktorého sa človek rozhoduje, MUSÍ stavať na tej istej funkcii
  výberu ako samotný beh.** `listRestockWaiting` aj `selectRestockCandidates`
  volajú spoločnú `allRestockCandidates` (`restock/queries.ts`) — druhá kópia
  podmienok by sa skôr či neskôr rozišla a majiteľ by overil iné produkty, než
  by sa naozaj prepli. Integračný test to drží (`overovací zoznam vylučuje
  detailOnly rovnako ako samotné prepínanie`).
- **`supplier_stock` je od issue 224 kľúčovaná na dvojicu `(link, size_label)`,
  nie len na `link`** — 965 z 2179 odkazov pokrýva VIAC našich variantov
  (rôzne veľkosti), a dodávateľ hlási dostupnosť PO veľkosti. `size_label=''`
  = "dostupnosť CELÉHO odkazu" (jednoveľkostný produkt, alebo doména bez
  `SIZE_AVAILABILITY_RULES` pravidla — nezmenené správanie). `run.ts`'s
  `writeSupplierStockRows` VŽDY vymaže riadky linky mimo aktuálne zapisovanej
  množiny — blanket (`''`) a per-veľkostné riadky sa pre TEN ISTÝ odkaz
  NIKDY nesmú stretnúť naraz, inak by `restock/queries.ts`'s JOIN (`size_label
  = coalesce(variant.size_label,'') OR size_label = ''`) mohol jeden variant
  spárovať s DVOMA riadkami naraz (jeho vlastným aj cudzím blanket riadkom).
- **NÁŠ `variant.size_label` sa NEMUSÍ zhodovať s dodávateľovým textom
  znak-po-znaku — Shoptet ukladá skrátený tvar tej istej veľkosti.**
  Zmerané v produkčnej DB (issue 224): náš `"L-X"` = dodávateľov `"L/XL"`
  (shop.lasting.eu). `matchSizeLabel` (`parse.ts`) preto rozdelí OBE strany
  na časti (oddeľovače preč) a porovná POZIČNE — zhoda platí pri PRESNEJ
  zhode ALEBO keď je jedna časť PREFIXOM druhej na tej istej pozícii ("X" ~
  "XL"), nikdy pri inom počte častí ani pri VIACNÁSOBNEJ (nejednoznačnej)
  zhode. Toto NIE JE AI dohad — je to deterministický, testovaný algoritmus.
- **JSON-LD sa na doméne s `SIZE_AVAILABILITY_RULES` pravidlom (issue 224:
  `shop.lasting.eu`, PrestaShop) NIKDY neberie ako dostupnosť KONKRÉTNEJ
  veľkosti — hlási len JEDNU (predvolenú/`checked`) veľkosť a vie byť s
  vlastným per-veľkostným zoznamom v priamom rozpore** (živý dôkaz: JSON-LD
  hlásil `InStock` pre veľkosť, ktorej vlastný `<li class="sklademNE">`
  zoznam hovorí opak). `parseSizeAvailability` číta zoznam veľkostí PRIAMO
  (trieda `sklademANO`/`sklademNE`, veľkosť v `title=""`) a keď taký zoznam
  existuje, `parsePage` (JSON-LD/meta/text) sa pre tento odkaz vôbec
  nepoužije — rovnaká disciplína ako issue 223/225's textové/viditeľné
  pravidlá, len na ÚROVNI veľkosti namiesto úrovne stránky.
- **Na `shop.lasting.eu` (PrestaShop) TÁ ISTÁ trieda `class="clearfix
  product-variants-item"` nesie AŽ TRI rôzne atribútové skupiny na jednej
  stránke naraz — Odstín (shade), VELIKOST (size), Barva (color) — code
  review issue 224 to odhalil naživo. Rozlišuje ich AŽ vlastný popisok
  `<span class="control-label">VELIKOST…`, a kontrola popisku MUSÍ byť
  ukotvená (`^`) HNEĎ za otváracou značkou danej skupiny — široké okno
  "obsahuje niekde v okolí" zasiahne aj do popisku NASLEDUJÚCEJ skupiny,
  keď je tá predchádzajúca krátka. Rovnaká trieda chyby ako issue 223's
  huntingshop.eu karuselová kolízia — pri KAŽDOM ďalšom per-domain
  extraktore over, či zdieľaná CSS trieda naozaj patrí LEN tomu, čo si
  myslíš, alebo aj iným skupinám/blokom na tej istej stránke.
- **`MAX_PAGE_BYTES` (2 MB pri zavedení issue 212, teraz 5 MB) sa dá
  prekročiť aj na REÁLNE malom produkte — whitespace-bloat v dodávateľovej
  šablóne, nie objem skutočného obsahu.** Odhalené AŽ post-deploy overením
  proti nasadenej appke (issue 224): `shop.lasting.eu`'s BONY čiapka má
  celú stránku 2 180 285 bajtov, takmer výhradne z opakovaného whitespace
  v "Odstín" skupine (skutočný obsah po zošmiznutí medzier ~168 000
  bajtov). Keďže JSON-LD sedí blízko začiatku `<head>` a per-veľkostný
  zoznam AŽ ZA touto bloatovanou skupinou, orezaná fixtúra ANI orezaný
  vzorkový test tento problém odhaliť NEMÔŽE — fixtúra je z definície
  malá. **Test na KAŽDÝ ďalší per-domain extraktor, ktorý číta niečo
  BLIŽŠIE KU KONCU stránky než JSON-LD:** over živo proti NASADENEJ appke
  (nie proti vlastnému uncapped curl-u), že sa dáta cez `MAX_PAGE_BYTES`
  strop skutočne dostanú — orezaná fixtúra to nezaručí.
- **Nová tabuľka MUSÍ pribudnúť do `TRUNCATE` zoznamu v
  `tests/helpers/db.ts`, inak testy zlyhajú AŽ pri druhom behu.** Pri #212 to
  bolo obzvlášť zákerné: prvý beh prešiel (prázdna tabuľka), druhý beh našiel
  vlastné čerstvé zápisy z prvého behu, vyhodnotil ich ako platné potvrdenia
  a preskočil VŠETKY odkazy — testy padli na „skipped 2, checked 0" bez
  akejkoľvek zmeny kódu.
- **`fetchSupplierPage` (`page-fetcher.ts`) dekóduje KAŽDÚ stránku ako
  `TextDecoder("utf-8")`, bez ohľadu na skutočnú `Content-Type; charset=`
  hlavičku.** `trigona.sk` (issue 230) posiela `windows-1250` — pri UTF-8
  dekódovaní windows-1250 bajtov sa diakritika (á/é/š/ť/…) zmení na mojibake
  (nesprávne, ale DETERMINISTICKY nesprávne znaky), zatiaľ čo ČISTO ASCII
  úseky (hex farby, triedy, číselné ID) ostávajú nedotknuté — ASCII bajty sú
  v UTF-8 aj vo windows-1250 identické. **Nový `extractRegion`/text-based
  extraktor na doméne s neznámou/nie-UTF-8 charset hlavičkou preto NESMIE
  hľadať/porovnávať diakritický text priamo z `html`** (napr. "Na sklade"
  ako reťazec by na trigona.sk fungoval len náhodou) — over `Content-Type`
  hlavičku (`curl -sI`) PRED písaním extraktora, a ak je iná než UTF-8,
  postav rozlíšenie na ASCII-only signáli (farba, trieda, číselné ID), nikdy
  na diakritickom texte. `trigonaStockRegion` preto číta farbu `#00b020`/
  `#024bbd` z `style="color: …"` namiesto porovnávania slov "Na sklade"/
  "1 - 4 týždne" priamo.
- **Krížová kontrola nášho odvodeného stavu proti Shoptetovmu vlastnému feedu
  (issue 226) sa počíta VŽDY NAŽIVO (`modules/catalog/feed-cross-check.ts`'s
  `findFeedStateConflicts`), nikdy do vlastnej perzistovanej tabuľky.**
  Dôvod: `shop_product_url` sa obnovuje DENNE (03:50), katalógový import
  HODINOVO (:20, `.claude/rules/scheduler.md`) — perzistovaná snímka
  rozporov spred hodiny by bola presne ten istý problém ("zastaraný
  odvodený stav"), aký sa touto funkciou rieši. Rovnaký architektonický vzor
  ako `allRestockCandidates`/`listRestockWaiting` nižšie — vždy odvoď zo
  živého stavu DB. `restock/queries.ts`'s kandidát (vždy `out_of_stock`) sa
  vylúči len keď feed hovorí `"in stock"` (`FEED_IN_STOCK`, exportované z
  `feed-cross-check.ts`, nikdy vlastný literál v `restock/queries.ts` —
  jeden zdroj pravdy pre string) — opačný smer rozporu (naše `sellable`
  proti feedovému `"out of stock"`) je pre KANDIDÁTOV irelevantný (kandidát
  je vždy `out_of_stock`), ale stále sa počíta do celkového čísla na
  obrazovke. Chýbajúci feed riadok (626 variantov, issue 220) sa MUSÍ
  vylúčiť explicitným `isNull(...) OR ne(...)` — samotné `!= 'in stock'`
  proti NULL vyhodnotí SQL na NULL, čo WHERE ticho zahodí (nie `false`).
- **Overený PROTIPÓL sa niekedy nedá nájsť aj napriek dôkladnému hľadaniu —
  vtedy sa pravidlo NEPRIDÁVA, nie hádá.** Issue 230: pre `trigona.sk` sa
  naživo overili OBE polarity (31 vzoriek, farba `#00b020`/`#024bbd`
  krížovo overená proti JSON-LD na TOM ISTOM produkte) → pravidlo pridané.
  Pre `wetland.sk` sa naživo overilo 67+ reálnych produktových stránok
  naprieč 3 kategóriami a VŽDY mal produkt rovnaký ("success") štítok —
  ani JEDEN overený vypredaný príklad sa nenašiel (6 `unknown` riadkov v
  produkčnej DB boli všetky HTTP 404 mŕtve odkazy, nie živé vypredané
  stránky). Záver: pravidlo pre `wetland.sk` sa NEPRIDALO, doména ostáva
  `unknown` presne ako predtým — dokumentované v `constants.ts` aj na
  ticket-e, nie tichá medzera. Vzor na ĎALŠIU doménu bez overeného
  protipólu: rovnaký postup, nie dohad podľa analógie s inou doménou.
- **NÁŠ VLASTNÝ e-shop (`forestshop.sk`) sa dokáže omylom dostať do
  `supplier_stock` presne tou istou cestou ako skutočný dodávateľ — issue
  227, 21 odkazov** — `extractSupplierLink` (`catalog/supplier-link.ts`)
  vytiahne AKÚKOĽVEK URL z `internalNote`, bez ohľadu na to, či ide o
  dodávateľa. Fix: `run.ts`'s `collectSupplierLinks` vylučuje `hostOf(url)
  === OWN_SHOP_HOST` (a jeho poddomény) PRI ZBERE, nikdy sa teda nedostane
  ani do prvého fetchu; `runSupplierStockLocked` navyše pri KAŽDOM behu
  vymaže staré riadky s týmto hostom (z behov PRED opravou) — inak by
  tvárili ako "nečitateľná dodávateľská doména" navždy. Počet vylúčených
  odkazov (`countOwnShopLinks`, živo z `internalNote`) sa ukazuje na
  obrazovke ako „Vlastný e-shop (nie dodávateľ)" — vylúčenie NIKDY nie je
  tiché. Ďalší podobný nález (iný vlastný/interný odkaz omylom vytiahnutý
  z voľného textu): rovnaký vzor — vylúčiť PRI ZBERE podľa hosta, vyčistiť
  staré riadky, ukázať počet, nikdy len ticho prestať zapisovať nové.
- **Zdroje populácie zberu (`collectSupplierLinks`, `run.ts`) — od issue 448
  EFEKTÍVNE odkazy, nie surový `internalNote`:** populácia = `resolveEffectiveSupplierLink`
  (`modules/orders/effective-supplier-link.ts` — override `product_supplier_link_override`
  ∪ URL vytiahnutá z `products.internalNote`) ∪ split `pairing_variant_link`
  (`pairing_decision.status='split'`, issue 423). Pred issue 448 čítal
  `collectSupplierLinks` LEN surový `internalNote` (`.where(isNotNull(internalNote))`)
  a bol JEDINÝ z čítacích ciest, čo `resolveEffectiveSupplierLink` NEVOLAL —
  potvrdený odkaz z Párovania zapísaný do override tabuľky (`product_supplier_link_override`)
  bol pre nočný zber neviditeľný až do Shoptet writebacku + ďalšieho catalog syncu
  (betalov: 35 produktov s poznámkou „betalov", ale len 11 s URL v poznámke;
  zvyšných 24 čaká na napárovanie, po ktorom sa override odkaz teraz zoberie
  OKAMŽITE). `.where(isNotNull(internalNote))` filter je odstránený — produkt
  s override ale bez poznámky by sa inak minul. `hostOf` normalizácia +
  vylúčenie vlastného e-shopu (issue 227) platia rovnako na efektívny odkaz.
  Efektívna linka je čistá JS funkcia (regex + coalesce), preto „načítaj do JS"
  vzor (rovnako ako `computeCatalogCoverage`/`determineReviewPopulationKeys`),
  nie SQL JOIN, ktorý by zaviedol druhú rozíditeľnú definíciu.
- **Ten istý Shoptet FRONTEND ŠABLÓNOVÝ prvok (`<span class="availability-
  label" ... data-testid="labelAvailability">`) sa opakuje NAPRIEČ VIACERÝMI
  nezávislými doménami (issue 227: `virginiashop.sk`, `tenolix.cz`,
  `luko.cz`) — jeden zdieľaný extraktor (`shoptetLabelAvailability` v
  `parse.ts`) pokrýva všetky tri naraz, namiesto samostatného pravidla na
  doménu.** Farba (`#009901`/`#cb0000`) rozhoduje len VIZUÁLNE — samotné
  ČÍTANIE ide cez text vnútri `<span>` (napr. "Skladom"/"Skladem"/
  "Momentálne(ě) nedostupné") a existujúci `availabilityFromText`, žiadna
  nová farebná mapovacia logika netreba (na rozdiel od `trigona.sk`, kde
  text sám osebe nestačil a rozhodovala farba). Tento `data-testid` sa
  VÔBEC nevykresľuje na VIACVARIANTOVÝCH produktoch (viac veľkostí/farieb
  naraz — každá veľkosť má VLASTNÝ `<span class="availability-label">` BEZ
  `data-testid`, JS ich prepína cez `parameter-dependent`/`no-display`
  triedy) — taký produkt ostáva `unknown` presne ako predtým
  (`whenRegionMissing: "unknown"`), nikdy sa nehádaj z niektorej z
  viacerých zhôd. `luko.cz` má tento jav VÄČŠINOVO (35 z 36 sledovaných
  odkazov sú viacveľkostné košele) — čitateľnosť tejto domény preto ostáva
  nízka aj po tejto zmene; skutočný pokrok by vyžadoval mapovanie
  číselných JS parameter-ID na konkrétnu veľkosť (podobné, ale iné, než
  `shop.lasting.eu`'s `title=""` atribút), mimo rozsahu tohto ticketu.
- **Per-domain textový extraktor (`TextAvailabilityRule.extractRegion`,
  `parse.ts`), ktorého markup nesie ČÍSELNÉ ID produktu (napr. trigona.sk's
  `id="StockCountText<ID>"`), MUSÍ toto ID krížovo overiť proti ID/slugu v
  scrapovanej `url` — nikdy sa nespoliehať LEN na empirický dôkaz "na N
  vzorkách sa vyskytlo vždy práve raz" (issue 241, code review na issue
  230).** `extractRegion` dostáva od issue 241 aj `url`
  (`(html, url) => string | null`); `trigonaStockRegion` vytiahne číslo
  produktu z `p-<ID>.xhtml` a cez `matchAll` (nie `.exec`) prejde VŠETKY
  výskyty, vyberie ten, čo sedí — inak by súvisiaci produkt s rovnakou
  značkou VYŠŠIE na stránke dal ISTO ZLÚ odpoveď, nie `unknown`. Dva
  zhodné-ID výskyty s ROZDIELNOU farbou sú tiež nejednoznačné → `unknown`
  (rovnaká disciplína ako `matchSizeLabel`). Extraktor BEZ takého ID v
  markupe (napr. `huntingshopDetailBadges`'s CSS-triedové vylúčenie,
  `fomeiAvailabilityRegion`'s "pred nadpisom Súvisiace") `url` nepotrebuje
  a nemusí ho ani deklarovať vo svojej signatúre — funkcia s menej
  parametrami je platný podtyp funkcie s viac parametrami v TypeScripte.
  **Reálne uložené trigona.sk odkazy v tomto repozitári sú často
  KATEGÓRIOVÉ** (`https://trigona.sk/smith-s/polovnicke/c199`,
  `supplier-link.test.ts`), nie `p-<ID>.xhtml` — vtedy sa ID vôbec
  nevytiahne a text fallback je vždy `unknown`, aj keď stránka nesie
  platný štítok (zámerné, nie regresia — over pri ĎALŠOM podobnom
  extraktore, či reálne uložené odkazy vôbec majú tvar, z ktorého sa dá
  ID vytiahnuť).
- **Český tvar "Momentálně nedostupné" (mäkké `ě`) je INÝ reťazec než
  slovenské "momentálne nedostupné" — `OUT_KEYWORDS` (`parse.ts`) potrebuje
  OBA, `.includes()` porovnanie nevidí medzi nimi žiadnu podobnosť** (issue
  227, `tenolix.cz`). Test na KAŽDÝ ďalší český text: over diakritiku
  znak-po-znaku voči slovenskému tvaru, nikdy nepredpokladaj, že jeden
  zoznam kľúčových slov pokryje obe reči automaticky.
- **Rovnaká karuselová kolízia ako `huntingshop.eu` (issue 223) sa vie
  zopakovať aj na SCHEMA.ORG MIKRODÁTACH (`<link itemprop="availability"
  href="...">`), nielen na voľnom texte — `fomei.com` (issue 227) má túto
  značku 10-11× na stránke (hlavný produkt + karusel "Súvisiace" nižšie).**
  Fix je identický princíp ako `odimon.sk` (issue 225, "prvý výskyt patrí
  hlavnému produktu"): hľadať LEN PRED nadpisom `>Súvisiace<`
  (`fomeiAvailabilityRegion` v `parse.ts`). Rozhoduje TRIEDA
  (`availability--inStock`/`availability--noStock`), nikdy viditeľný text —
  ten sa medzi produktmi líši ("na dotaz" pri `noStock` nie je vždy rovnaké
  slovo). Test na KAŽDÚ ďalšiu doménu s opakovaným mikrodátovým/textovým
  prvkom naprieč stránkou: nájdi nadpis podobný "Súvisiace"/"Odporúčame" a
  obmedz hľadanie na oblasť PRED ním, nikdy na celý dokument.
- **`chiruca.sk` (issue 227) nesie veľkosť AJ dostupnosť v JEDNOM viditeľnom
  texte `<option>` prvku (`<select id="simple-variants-select">`, "Veľkosť:
  38 - Vypredané (€100)") — na rozdiel od `shop.lasting.eu` (issue 224) tu
  netreba hľadať skupinovú hranicu ani popisok, celý `<select>` patrí
  jednému produktu, každý `<option>` je presne jedna veľkosť.** Dostupnosť
  sa číta z TEXTU (cez `availabilityFromText`), nikdy z `data-stock`
  atribútu (`-1`/`-2`) — ten by bol dohad bez preukázateľného mapovania,
  zatiaľ čo text je presne to, čo vidí zákazník. Naše `variant.size_label`
  sú u `chiruca.sk` holé čísla ("37".."47"), zhodujú sa priamo s
  dodávateľovým "Veľkosť: NN" bez potreby `matchSizeLabel`'s tolerantného
  porovnávania.
- **Per-doménové pravidlá (`TEXT_AVAILABILITY_RULES`/
  `VISIBLE_AVAILABILITY_RULES`) a ich extraktory od issue 307 žijú v
  `availability-domain-rules.ts`, NIE v `parse.ts`** — vyčlenené, lebo
  pridanie ďalších domén posunulo oba súbory (aj `parse.ts`, aj
  `parse.test.ts`) cez eslint `max-lines: 400` (`.claude/rules/testing.md`).
  `parse.ts` nesie generický algoritmus (`parsePage`, `fromJsonLd`,
  `fromMetaTags`, veľkostné pravidlá); `availability-domain-rules.ts` nesie
  per-doménovú znalosť. **Prvá verzia mala tieto dva súbory navzájom
  importované** (parse.ts → `textAvailabilityRuleFor`/`visibleAvailabilityFor`;
  availability-domain-rules.ts → `availabilityFromText`/`SupplierAvailability`
  späť z parse.ts) — funkčne bezpečný cyklický import (nič sa nevyhodnocuje na
  module-top-level v konfliktnom poradí), ale code review na issue 307 ho
  označil za krehký (budúci top-level kód v ktoromkoľvek súbore by ho mohol
  ticho rozbiť) a odporučil radšej mechanickú extrakciu. **Fix: tretí súbor
  `availability-primitives.ts`** nesie `SupplierAvailability` typ, `hostOf`,
  `availabilityFromText` a `decodeNumericEntities` — oba ostatné súbory naň
  závisia JEDNÝM smerom, žiadny cyklus. Nová doména pribúda do
  `availability-domain-rules.ts` (import z `availability-primitives.ts`,
  NIKDY z `parse.ts`), testy pre ňu do `parse-issue307.test.ts` (alebo
  ďalšieho tematicky vyčleneného súboru, ak by aj tento prerástol limit) —
  nikdy naspäť do `parse.ts`.
- **Číselné HTML entity (`&#xHH;`/`&#DDD;`) sa v extraktore dostupnosti
  MUSIA DEKÓDOVAŤ na skutočný znak (`decodeNumericEntities` v
  `availability-primitives.ts`), NIKDY len nevyprázdniť.** Code review na
  issue 307 odhalilo, že `roslerStockRegion`'s pôvodné vyprázdnenie
  (skopírované z ikonkového vyprázdnenia v `lesonaVisibleAvailability`, kde
  je SPRÁVNE — ide o Material-Icons kódové body v Private Use Area, nie o
  skutočný text) na `rosler.sk` ticho rozbíjalo diakritiku: doména kóduje
  KAŽDÚ diakritiku takto (naživo overené — "dn&#xED;" = "dní", "ma&#xE1;" =
  "malá", "no&#x17E;e" = "nože"), takže "vypredan&#xE9;" by sa vyprázdnením
  zmenilo na "vypredan " — nezhoduje sa so ŽIADNYM slovom v
  `OUT_KEYWORDS`, extraktor by ticho spadol na `unknown` namiesto
  `unavailable`. Skutočné dekódovanie funguje rovnako správne pre OBA
  prípady (diakritika → skutočný znak, ikonkový bod → neviditeľný PUA
  znak, ktorý sa nezhoduje so žiadnym slovom) — jedna zdieľaná funkcia,
  žiadna špeciálna vetva pre "tento typ entity vyprázdni, tamten dekóduj".
  Regresný test: `rosler-vypredane-noz-entita.html` (mechanizmus, nie
  naživo overená vzorka — genuinný vypredaný text sa na rosler.sk naživo
  nenašiel). Test pri KAŽDOM ďalšom extraktore, ktorý číta text z domény s
  neznámou entity-kódovacou konvenciou: over PRIAMO na živom `curl`u, či sa
  diakritika posiela ako entita alebo priamy UTF-8 znak (`grep -o
  '&#x[0-9A-Fa-f]*;' subor.html`), skôr než sa entita jednoducho vyprázdni.
- **Testovacia fixtúra, ktorej VLASTNÝ opisný HTML komentár cituje presne tú
  istú atribútovú syntax, akú hľadá jej vlastný regex, môže OMYLOM zhodiť
  test na SEBE SAMEJ — regex nájde zhodu vo VLASTNOM komentári fixtúry, nie
  v reálnom markupe nižšie.** Zistené issue 307 pri písaní `lesona-*.html`
  fixtúr: komentár opisujúci `<span id="product-availability">` obsahoval
  presne ten istý reťazec `id="product-availability"`, aký hľadal
  `LESONA_AVAILABILITY_RE` — regex sa zhodol s komentárom, nie s testovaným
  `<span>` nižšie (rovnaký jav postihol aj rozpísaný `<dt>Dostupnosť</dt>
  <dd><span class="in-stock|out-of-stock">` v `rappa-*.html` komentári a
  `<div class=product-detail-stock>` v `rosler-*.html` komentári). Fix:
  komentáre k fixtúram OPISUJÚ markup slovami alebo s pomlčkou/tromi
  bodkami rozbitou syntaxou (`id="product-…"` namiesto `id="product-
  availability"`), NIKDY necitujú presnú reťazcovú podobu, akú extraktor
  hľadá. Test pri KAŽDEJ ďalšej per-domain fixtúre: over, že jej vlastný
  komentár neobsahuje literálny reťazec zhodný s regexom, ktorý má
  fixtúra testovať — najjednoduchšie priamym `node -e` behom extraktora
  proti danej fixtúre PRED spustením vitestu, presne ako sa to tu odhalilo.
- **`lesona.sk` (PrestaShop) je ĎALŠÍ dôkaz, že schema.org mikrodáta VEDIA
  KLAMAŤ NAPRIEČ PLATFORMAMI, nielen na Shoptete (`odimon.sk`, issue 225).**
  Naživo overené na reálnom vypredanom produkte (slúchadlá 3M Peltor, id 58):
  `<link itemprop="availability" href="https://schema.org/InStock"/>` tvrdí
  dostupné, ale viditeľný `<span id="product-availability">` s ikonkou
  `product-unavailable` hovorí "Vypredané" a tlačidlo "Vložiť do košíka" je
  `disabled`. Táto appka `itemprop=` mikrodátovú formu (na rozdiel od
  `<script type="application/ld+json">`, ktorý číta `fromJsonLd`) VÔBEC
  neparsuje — preto sa NEROZŠIROVAL parser o jej čítanie, len sa pridalo
  `VISIBLE_AVAILABILITY_RULES` pravidlo čítajúce výhradne viditeľný prvok.
  Test na KAŽDÚ ďalšiu doménu s `itemprop="availability"` mikrodátami:
  NIKDY sa neberú ako posledné slovo bez porovnania s viditeľným stavom pri
  produkte — mikrodáta klamú nezávisle od platformy (Shoptet aj PrestaShop
  overené), pravdepodobne to platí širšie.
- **`rappa.cz`** (issue 307): `<dt>Dostupnosť</dt><dd><span class="in-stock|
  out-of-stock">…</span></dd>` v tabuľke parametrov, jediný výskyt na
  stránke, obe polarity naživo overené. Rozhoduje TRIEDA, nikdy text (text
  nesie aj počet kusov, "skladom (50 a viac ks)").
- **`rosler.sk`** (issue 307): `<div class=product-detail-stock>…</div>`
  (bez úvodzoviek v reálnom markupe), odlišná trieda od karuselu
  (`product-thumb-stock`). Text ide cez existujúci `availabilityFromText`.
  Naživo overené texty: "Skladom N ks" (available) a "Do 14 dní" (dodanie na
  objednávku — nie skladom teraz, correctně padá na `unknown`). Genuinný
  vypredaný text sa NENAŠIEL napriek prehľadaniu 20 uložených odkazov + 3
  kategórií — presne ako `wetland.sk` (issue 230): pravidlo sa NEHÁDA,
  žiadne vlastné mapovanie "Do N dní" → unavailable sa nepridalo.
- **`index.ts`'s `createApp(db, {...})` volanie MUSÍ reálne odovzdať KAŽDÝ
  voliteľný HTTP dep kľúč, na ktorý sa `http/app.ts` odvoláva — chýbajúci
  kľúč sa NEPREJAVÍ pri `tsc`/lint (`AppOptions`'s pole je `?:`, teda platne
  chýbajúce), len ticho spadne na fail-closed fallback.** Issue 319: `restock`
  kľúč v `createApp(...)` chýbal úplne (na rozdiel od `postaUncollected`/
  `orderReminder`/`nedostupne`/`orderMerge`/`dpd`, ktoré tam všetky sú),
  hoci `runRestockFn` (o pár riadkov vyššie, pre scheduler) má REÁLNE
  `shoptetAdminUser`/`shoptetAdminPassword` premenné správne zostavené.
  Dôsledok: manuálne "Spustiť teraz" (`POST /api/restock/run-now`) v
  produkcii VŽDY zlyhalo na prihlásení do Shoptetu (prázdne prihlasovacie
  údaje z `http/app.ts`'s fallbacku), zatiaľ čo naplánovaný nočný beh
  fungoval normálne — appka teda "z väčšiny funguje", takže sa to
  neprejavilo ako zjavná regresia. Nájdené AŽ živým dôkazom proti produkčnej
  `job_run`/`audit_events` tabuľke (job_run `failure` riadok s presne
  predpovedanou chybovou hláškou, tesne po ručnom "Spustiť teraz" kliku, s
  chýbajúcim zodpovedajúcim `audit_events` záznamom — HTTP handler
  `record()` sa volá LEN pri úspechu). **Test pri KAŽDEJ ĎALŠEJ novej
  automatizácii pridávajúcej svoj vlastný voliteľný dep do `AppOptions`
  (`http/app.ts`):** over PRIAMO, že `index.ts`'s `createApp(db, {...})`
  volanie ten kľúč SKUTOČNE odovzdáva — `grep -n "options\." apps/api/src/
  http/app.ts` (čo trasa POTREBUJE) vs. `createApp(db, {` blok v `index.ts`
  (čo REÁLNE dostáva) sa musia zhodovať. `index.ts` beží celý na
  module-top-level (migrácia + `serve()`), takže sa nedá bezpečne
  importovať v teste — regresný test preto overuje ZDROJOVÝ TEXT staticky
  (`apps/api/src/index-wiring.test.ts`), regexom na skutočné premenné, nie
  len na prítomnosť reťazca s menom kľúča.
- **Celý beh (~2160 odkazov, sériový, `PER_HOST_DELAY_MS` medzi rovnakým
  hostom) trvá reálne ~72 minút** (zmerané z `job_run.started_at`/
  `finished_at`, viacero po sebe idúcich nočných behov). Post-deploy
  overenie zmeny v parseri preto NEČAKAJ na jeden krátky `curl`/API test —
  ručné "Spustiť teraz" treba naozaj počkať celé (foreground, nie
  background — subagent by inak zomrel), alebo overiť užšie priamo cez
  `docker compose exec postgres psql` dopyt na `supplier_stock` po
  konkrétnej doméne PO dokončení behu (`SELECT status FROM job_run WHERE
  id=...`).
- **Snímka `supplier_stock` PRED čerstvým plným behom PODHODNOCUJE skutočnú
  "unknown" populáciu — `MAX_AGE_HOURS=20` znamená, že rad riadkov môže byť
  dni staré medzi dvomi plnými behmi.** Issue 332: prvá diagnostika (10.8.)
  napočítala 434 `unknown` riadkov naprieč 28 doménami; ČERSTVÝ plný beh
  spustený PRI OVEROVANÍ TEJTO ZMENY (11.8., ~72 min, `job_run` `success`)
  ich odhalil 811, vrátane domén, ktoré tento ticket vôbec nemenil
  (`wetland.sk` 6→184, `tthunt.sk` 1→90) — nie regresia, len presnejší,
  ČERSTVÝ obraz skutočnej populácie. Test pri KAŽDOM ĎALŠOM "koľko riadkov
  padá na unknown" meraní PRED písaním kódu (ako táto sekcia žiada vyššie):
  ak od posledného PLNÉHO behu ubehlo viac než pár hodín, počítaj s tým, že
  reálne číslo bude VYŠŠIE, než ukáže okamžitá snímka — spusti čerstvý beh
  (alebo aspoň skontroluj `job_run.finished_at` poslednej úspešnej), než sa
  z tabuľkového dopytu vyvodí "toto je celý rozsah problému".
- **Issue 332: po issue 330's fail-closed zmene je populácia domén bez
  pravidla VÄČŠIA, než ukázala pôvodná diagnostika (10.8.: 9/36) — naživo
  premerané 11.8. proti produkcii: 28 domén, 434 riadkov.** Pridané tri nové
  domény, KAŽDÁ so živo overeným dôvodom, prečo sa dá spoľahlivo prečítať:
  `hunting24.cz`/`chocolenka.cz` (rovnaká Shoptet šablóna ako issue 227/307 —
  len pridanie hosta do existujúceho `shoptetLabelAvailability`) a
  `vreckovynoz.sk` (nová vlastná trieda `<p
  class=product-detail__availability>`, bez úvodzoviek v markupe, rovnaký
  jav ako `rosler.sk`). Doména kóduje diakritiku ako číselné HTML entity
  inde na stránke (naživo overené), preto `decodeNumericEntities`
  defenzívne, presne ako `rosler.sk`.
- **`shoptetLabelAvailability`'s pôvodný regex predpokladal, že
  `data-testid="labelAvailability"` `<span>` NIKDY nenesie vnorený ĎALŠÍ
  `<span>` — `chocolenka.cz` (issue 332) to porušuje.** Táto doména obaľuje
  text label-u vlastným vnoreným tooltip `<span title="…dodacia
  poznámka…">Skladem</span>` (hover s dodacou lehotou). Pôvodný `[\s\S]*?`
  capture sa zastavil na PRVOM `</span>` (tomto vnorenom), takže vrátený
  text niesol nezošmiznutý HTML fragment vrátane celej `title=` hodnoty —
  fungovalo to doteraz len náhodou (slovo "Skladem" bolo súčasťou textu a
  tooltip neniesol žiadne kolízne `OUT_KEYWORDS` slovo). Fix: `title=`/`alt=`
  atribúty sa stripujú PRED stripom tagov, nie po ňom — hodnota vie niesť
  vlastný `<br />` vnútri úvodzoviek, ktorý by jednoduchý `<[^>]+>` strip
  inak rozdelil na dve časti uprostred atribútu. Test pri KAŽDEJ ĎALŠEJ
  doméne pridanej do `shoptetLabelAvailability`'s zoznamu: over naživo, či
  `data-testid="labelAvailability"` `<span>` obaľuje ešte niečo iné než holý
  text — Shoptet šablóny sa medzi zákazníkmi líšia aj v tomto.
- **Rovnaká Shoptet trieda `class="availability-label"` existuje aj na
  NOVŠEJ šablóne verzii (werra.cz/soxland.sk/citrade.cz, issue 332), ale BEZ
  `data-testid="labelAvailability"` vôbec — tá šablóna ukazuje len
  `numberAvailabilityAmount` (počet kusov PRI KAŽDEJ veľkosti v selecte
  zvlášť), žiadny jeden súhrnný text pre "aktuálne zvolenú" veľkosť.**
  Pridanie týchto troch domén do `shoptetLabelAvailability`'s zoznamu by
  nezmenilo nič (extraktor by vždy vrátil `null`) — ZÁMERNE vynechané,
  overené naživo `grep`om testid zoznamu celej stránky, nielen chýbajúcou
  zhodou na jednej vzorke. Test pri KAŽDEJ ĎALŠEJ Shoptet doméne: over, že
  `data-testid="labelAvailability"` v stránke SKUTOČNE existuje (nielen
  trieda `availability-label`) predtým, než sa pridá do zoznamu.
- **Issue 332 ZÁMERNE nevyriešilo viacero ďalších veľkých domén — každá s
  vlastným naživo overeným dôvodom, žiadny dohad:** `tatragoat.sk` (22
  neznámych) je momentálne celá v "Režim údržby" (HTTP 503,
  `retry-after: 3600`) — nedá sa postaviť pravidlo na stránke, ktorá sa
  nedá stiahnuť. `lovuzdar.cz` (21) aj `huntingland.sk` (8) majú hlavný
  produkt BEZ vlastného static dostupnostného prvku — u `huntingland.sk`
  (PrestaShop) je `<span id="availability_value">` PRÁZDNY (dopĺňa sa AJAXom
  po JS) a JEDINÉ nájdené `class="availability"` výskyty patria karuselu
  "Súvisiace"/"Kúpené spolu" ĎALEKO za hlavným produktom; u `lovuzdar.cz`
  všetkých 7 nájdených "Skladem" výskytov patrí grid-u podobných produktov,
  hlavná produktová oblasť nemá žiadny stock indikátor vôbec.
  `b2b.orbis-textil.de` (11) vyžaduje prihlásenie (naživo overené: redirect
  na `cl=account`). `betalov.sk` (11) nemá ŽIADEN viditeľný dostupnostný
  text v static HTML — jediný signál je GA `dataLayer` JS premenná
  (`is_item_in_stock`), presne ten typ strojového údaja bez viditeľného
  sprievodcu, čomu sa má tento ticket vyhnúť. `termovel.sk` (4) má jediný
  kandidát (`deliveryTime`) v `parameter-dependent no-display` obaľovači
  (JS-riadený, rovnaký jav ako `luko.cz`). `grube.de` (4) je JS SPA — static
  HTML po presmerovaní je prázdne/500. `b2b.outhunt.eu` (2) má jediný
  nájdený signál vnorený v app-state JSON (`"stockStatus":"in_stock"`), bez
  oddeleného viditeľného textu na krížovú kontrolu.
- **"Prepnuté produkty" (história prepnutí, `restock_event`) bola DOTERAZ
  jediná z troch tabuliek na tejto obrazovke bez akéhokoľvek odkazu na náš
  produkt** — dostala ho od issue 329 rovnakým LEFT JOIN vzorom ako
  `allRestockCandidates`'s `ourUrl`, priama adresa z feedu
  (`.claude/rules/shop-feed.md`), NIKDY fallback na vyhľadávanie
  (`shopLinks.ts`'s `feedOnlyProductLink`, na rozdiel od `ourProductLink`
  používaného v "Pripravené na prepnutie" vyššie). Pri ĎALŠOM "chcem odkaz
  aj tu" požiadavke na túto obrazovku najprv skontroluj, ktorá z troch
  tabuliek (rozpory / prepnuté / čakajúce) ho ešte nemá, namiesto
  predpokladu že všetky tri sú rovnaké.
  `restock_event` je plochá tabuľka BEZ FK na `variant`/`product`
  (`schema-restock.ts`) — e2e fixtúra preň (`e2e-fixtures-restock-events.ts`)
  teda nepotrebuje seedovať ani jedno z nich, len samotné udalosti (+
  zodpovedajúci `shop_product_url` riadok pre prípad S odkazom).
- **Vitest `screen.getByRole(..., {name})` bez `within(riadok)` sa rozbije
  hneď, ako pribudne DRUHÝ riadok s ROVNAKÝM prístupným menom** — issue 329
  pridalo druhý `restock-event-*` riadok do `RestockSection.test.tsx`'s
  `STATUS.events` fixtúry (kvôli "chýbajúca adresa" prípadu) a existujúci
  `screen.getByRole("link", {name: "skladom"})` (dovtedy jediný takýto
  odkaz na stránke) spadol na "found multiple elements", lebo oba riadky
  zdieľajú `supplierAvailabilityText: "skladom"`. Fix: `within(riadok)
  .getByRole(...)`, presne rovnaký princíp ako existujúce Playwright
  substring-kolízie (`.claude/rules/testing.md`), len vo vitest/RTL tvare.
  Test pri KAŽDOM ďalšom pridaní DRUHÉHO riadku do JUŽ existujúcej
  jedno-riadkovej vitest fixtúry: `grep` existujúce `screen.getByRole`/
  `screen.getByText` volania v tom istom test súbore — nesporí sa nejaké o
  text, ktorý bude po zmene zdieľaný viacerými riadkami?
- **Split (per-veľkosť) linky sa do kontroly dostupnosti zapájajú ČÍTANÍM
  `pairing_variant_link` PRIAMO, nie cez `products.internalNote` (issue 423).**
  Split produkt (`pairing_decision.status='split'`) nemá produktovú
  `internalNote` linku — jeho linky žijú per veľkosť. `collectSupplierLinks`
  (`run.ts`) preto navyše pozbiera split-riadené `pairing_variant_link.url`
  (gate `status='split'`, rovnaká `extractSupplierLink` normalizácia +
  vylúčenie vlastného e-shopu ako produktové linky). Každá split linka je
  JEDNA URL na JEDNU veľkosť (jednoveľkostná stránka), takže sa scrapne ako
  BLANKET (`size_label=''`) — `collectOurSizesByLink` (per-produkt
  `internalNote` grouping) ju zámerne NEZAHRNIE, takže sa nikdy neskúša ako
  viac-veľkostná stránka.
- **`restock/queries.ts`'s efektívna linka je od issue 423 `coalesce(CASE WHEN
  decision.status='split' THEN per-veľkosť link END, produktová linka)`.**
  Split variant sa tak spáruje na svoj BLANKET `supplier_stock` riadok cez
  existujúcu `size_label=''` vetvu OR-u. **Pasca poradia JOIN-ov:** dva nové
  LEFT JOINy (`pairing_variant_link` na `variant.code`, `pairing_decision` na
  `product.key`) MUSIA byť v reťazi PRED `supplierStock` innerJoinom — jeho ON
  klauzula referencuje `link` (coalesce nad týmito dvoma tabuľkami), a Postgres
  vyžaduje, aby referencovaná tabuľka bola v JOIN zozname skôr. Non-split
  variant: `coalesce` padne na produktovú linku → NULOVÁ zmena existujúceho
  správania (overené restock-run regresiou). Dormantná per-veľkosť linka
  (produkt nerozdelený) sa ignoruje — `status != 'split'` → produktová linka.
- **Split-governed predikát (`pairing_variant_link existuje A
  pairing_decision.status='split'`) sa aplikuje KONZISTENTNE na 4 miestach
  (issue 423):** `select-variant-links.ts` (writeback vyberie), `select-
  changes.ts` (writeback vylúči z produktovej cesty), `collectSupplierLinks`
  (scrape), `restock/queries.ts` (efektívna linka). Dormantná per-veľkosť
  linka (link nastavený v paneli, ale "✓ Hotovo" nekliknuté, alebo produkt
  vrátený z rozdelenia) sa VŠADE ignoruje — jej efektívna linka je produktová.
  Pri KAŽDEJ ďalšej zmene split logiky over všetky štyri miesta naraz.
