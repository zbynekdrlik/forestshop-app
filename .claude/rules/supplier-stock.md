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
