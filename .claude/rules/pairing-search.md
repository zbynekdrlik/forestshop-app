---
paths:
  - "apps/api/src/modules/pairing-search/**"
  - "apps/api/src/modules/pairing-review/**"
  - "apps/api/src/http/pairing-review-routes.ts"
  - "apps/web/src/pairingReviewApi.ts"
  - "apps/web/src/components/PairingReview*.tsx"
  - "apps/web/tests/e2e/pairing-review.spec.ts"
  - "scripts/e2e-fixtures-pairing-review.ts"
---

# Profesionálne párovanie produktov — jadro vyhľadávania (issue 387)

Port starej appky (`https://github.com/zbynekdrlik/parovanie-produktov`,
commit `60b6164`) do tejto appky, po etapách (E1..E9 — návrh
https://github.com/zbynekdrlik/forestshop-app/issues/387#issuecomment-5273377438).
**Tento súbor NAHRADIL `.claude/rules/restock-links.md`** — issue 387 E8
vyradilo #311 aj jeho playbook súbor (návrh, sekcia 4); router v
`CLAUDE.md` má odvtedy len tento riadok.

- **`rapidfuzz.fuzz.token_set_ratio` je CASE-SENSITIVE bez akéhokoľvek
  predspracovania (žiadne `.lower()`) a stará appka ho volá presne takto
  (`ranking.py`'s `_name_score`) — npm balík `fuzzball` (fuzzywuzzy port)
  dáva na REÁLNYCH príkladoch výrazne INÉ hodnoty** (issue 387 E1, naživo
  overené: "Strike Nohavice DEERHUNTER 3989-388" vs "Strike Nohavice
  Deerhunter 3989" → rapidfuzz 66,67, fuzzball 100 — `fuzzball` si vstup
  interne inak predspracúva). Preto `token-set-ratio.ts` je VLASTNÁ
  implementácia, nie `fuzzball`. Algoritmus (klasický fuzzywuzzy/rapidfuzz
  `token_set_ratio`: tokenizácia na whitespace → zoradený prienik/rozdiely
  množín tokenov → `max()` z troch `ratio()` volaní, kde `ratio(a,b) = (1 -
  indelDistance(a,b)/(len(a)+len(b)))*100` a `indelDistance = len(a)+len(b)
  - 2*LCS(a,b)`) bol pred portom overený proti NAINŠTALOVANEJ `rapidfuzz`
  (pip) na 700 náhodných/štruktúrovaných dvojiciach vrátane slovenskej
  diakritiky — 0/700 nezhôd. Test pri KAŽDEJ ĎALŠEJ zmene tohto súboru:
  neuprav vzorec bez opätovného overenia proti skutočnej `rapidfuzz`
  (`pip install --break-system-packages rapidfuzz` na tomto boxe, alebo
  ekvivalent), nikdy len proti `fuzzball`/vlastnej intuícii.
- **`rapidfuzz.fuzz.token_set_ratio('', 'x')` (a ľubovoľný prázdny/len-
  whitespace vstup na jednej strane) vracia `0`, HOCI čistý fuzzywuzzy
  vzorec bez explicitného guardu by dal `100`** (prázdny `sorted_sect`
  porovnaný s prázdnym `sorted_1to2`/`sorted_2to1` — `ratio("","")=100`).
  `tokenSetRatio` preto má explicitný guard na začiatku (`s1.trim()===""
  || s2.trim()===""` → `0`), overený empiricky proti rapidfuzz, nie
  odvodený z dokumentácie vzorca.
- **Externý dodávateľský kód (`external_code`) je v tejto appke stĺpec
  VARIANTU, nie zoskupeného produktu ako v starej appke (CSV grouping mal
  presne jeden kód na zoskupený produkt — prvý neprázdny videný pri
  groupingu).** `types.ts`'s `PairingProduct.externalCodes` preto nesie
  POLE všetkých odlišných, neprázdnych kódov naprieč variantmi produktu.
  `queries.ts`'s `buildQueryLadder`/`buildQueryVariants` skúšajú KAŽDÝ kód
  ako samostatný stupienok/variant (pred menovými), `ranking.ts`'s
  `isCodeHit` je pravdivé, keď sa HOCIKTORÝ z kódov nájde v kandidátovi
  (`.some(...)`, nikdy len `externalCodes[0]`). Táto adaptácia je MOJA
  interpretácia návrhovej vety „query set skúša VŠETKY odlišné external
  kódy variantov" — overená review subagentom, konzistentne aplikovaná v
  oboch súboroch.
- **`normalize.ts`'s `clean_name`'s vedúci-index regex (`^\d{1,3}\s+(?=\D)`)
  NEODREZE 4+-ciferné čísla na začiatku mena** — "1003 Bunda FOREST" ostáva
  nedotknuté (regex sa zastaví po 3 číslicach a potrebuje whitespace hneď
  za nimi, čo pri "1003" nesedí), zatiaľ čo "100 Bunda FOREST" → "Bunda
  FOREST". Zámerné (chráni pred odrezaním skutočného číselného kódu na
  začiatku mena), presne ako stará appka — over pri KAŽDEJ zmene tohto
  regexu proti `normalize.py`'s pôvodnému, nikdy nezjednodušuj hranicu.
- **Tento monorepo má `noUncheckedIndexedAccess: true`** (`tsconfig.base.
  json`) — akýkoľvek `pole[i]`/`retazec[i]` prístup vracia `T | undefined`,
  aj keď je index dokázateľne v rozsahu (DP tabuľky v `token-set-ratio.ts`,
  `ranked[0]` po kontrole `candidates.length`). Vzor použitý tu: `?? 0`/`??
  ""` fallback pri numerických/reťazcových DP bunkách (runtime hodnota je
  vždy definovaná, fallback len uspokojuje statickú kontrolu),
  `const [best] = ranked; if (!best) return ...;` namiesto `ranked[0]`
  priamo tam, kde by chýbajúca hodnota bola SKUTOČNÁ chyba (nedosiahnuteľná
  vetva s komentárom prečo).
- **Fixtúrové testy proti REÁLNYM referenčným hodnotám (nie len proti
  vlastnej intuícii o algoritme) sú JEDINÝ spoľahlivý spôsob, ako overiť
  doslovný port číselného algoritmu.** `token-set-ratio.test.ts` nesie
  presné hodnoty odchytené z nainštalovanej `rapidfuzz` — pri ĎALŠOM porte
  numerického algoritmu zo starej appky (napr. E2's parsery, E4's verify
  kaskáda) rovnaký vzor: nainštaluj referenčnú knižnicu/skript, vygeneruj
  batériu vstup→výstup dvojíc, over TS port proti nim priamo (nie len proti
  ručne napísaným testom, ktoré by mohli zopakovať rovnakú chybu ako
  implementácia).

## E2 — SearchClient + 3 adaptéry (`client.ts`, `adapters/`)

- **`code`/`price` sa pri PARSOVANÍ VÝSLEDKOV VYHĽADÁVANIA nikdy
  nenapĺňajú — zostávajú `null`, doslovne ako stará appka.** Ani jeden z
  troch `suppliers/*.py` parserov `Candidate.code`/`.price` nenastavuje
  (`models.Candidate(name, url)`, defaulty `None`) — kód sa dopĺňa až pri
  overení na DETAILE produktu (`verify.py`, mimo E2, plánované E4). Zadanie
  E2 síce menuje "kód/cena" medzi extrahovanými poľami, ale doslovný port
  necháva `code`/`price` `null` — pri ĎALŠEJ zmene parsera never sa nepokúšaj
  "vylepšiť" extrakciu o cenu/kód zo search-výsledkov, kým sa nezmení sám
  zdrojový kontrakt (`PairingCandidate`).
- **`SupplierAdapter` (`adapters/types.ts`) zlučuje starú appka's oddelený
  `config.SUPPLIERS` (URL šablóny) + `client.PARSERS` (parsery) do JEDNÉHO
  objektu na dodávateľa, registrovaného v `adapters/registry.ts` pod
  `adapterKey`.** `baseUrl`/`buildSearchUrl` sú súčasťou KÓDU adaptéra, nie
  DB — `supplier.wholesale_base_url` (E1's `schema-pairing.ts`) je pre
  zobrazenie/budúce overenie (E3+), nikdy pre stavbu vyhľadávacej URL.
  Nový dodávateľ = nový `adapters/<meno>.ts` súbor + 1 riadok v
  `registry.ts` (presne ako stará appka's "Pridanie nového dodávateľa"
  postup, `.claude/skills/suppliers/SKILL.md`).
- **Živo overené 13. 8. 2026 — všetky tri selektory zo starej appky STÁLE
  PLATIA bezo zmeny** od 27. 6. 2026: `div.product-miniature__title a.link`
  (wetland/PrestaShop), `#snippet--productList` + `.product-col` +
  `a.mh-100`/`.product-title a` (betalov/Nette), `.product-list__results`
  + `a.product-card` + `img[alt]` (odimon/BUXUS). Pri drifte markupu
  (E2's riziko #2 v návrhu) over PRVÝ krok vždy živým `curl` (session
  warm-up + throttle, presne ako `client.ts`), nikdy len proti fixtúre —
  fixtúra je z definície malá/stará.
- **BETALOV's `#snippet--productList` má DVA tab-pane so SAMOSTATNÝMI CSS
  triedami na kartu** — `#home` (mriežka) používa `.product-col`, `#profile`
  (zoznam) používa `.product-card` BEZ `product-col`. Parser scopuje na
  `.product-col`, takže zoznamový pohľad sa NIKDY neparsuje — na živej
  stránke preto NEEXISTUJE prirodzený duplikát v rámci `.product-col`
  (overené 13. 8. 2026, dopyt "nohavice": 16 kariet, 16 distinct URL).
  Dedup/exclusion-prefix testy preto používajú SKONŠTRUOVANÉ karty
  (zdokumentované priamo v komentári fixtúry) — rovnaký precedens ako
  `supplier-stock/fixtures/rosler-vypredane-noz-entita.html`.
- **cheerio's `$.root()` má typ `Cheerio<Document>`, NIE `Cheerio<Element>`
  — premenná `snippet.length > 0 ? snippet : $.root()` (zmiešaný typ) sa
  nedá bezpečne zavolať `.find(...)` na nej pod `strictTypeChecked`**
  (`TS2684: The 'this' context ... is not assignable`). Fix (vzor v
  `betalov.ts`/`odimon.ts`): DVE samostatne typované vetvy —
  `scope.length > 0 ? scope.find(selector) : $(selector)` (fallback
  hľadá selektor na CELOM dokumente, nie cez `.find()` na
  `Cheerio<Document>`) — nikdy si neuklad `$.root()` do premennej, ktorú
  neskôr voláš `.find()`.
- **`Record<string, string>` objekt (napr. HTTP hlavičky) pod
  `noPropertyAccessFromIndexSignature`/`strictTypeChecked` VYŽADUJE
  bracket notáciu pri PRIRADENÍ NOVÉHO kľúča po inicializácii** —
  `headers.cookie = x` hlási `TS4111`, `headers["cookie"] = x` prejde.
  Platí to len pre prístup MIMO object-literal inicializátora (kľúče
  zadané priamo v `{ "user-agent": ..., accept: ... }` sú v poriadku).
- **`SearchClient`'s throttle (0,7 s) je identity-check proti
  `nativeFetcher` singletonu (`this.fetcher === nativeFetcher`), presne
  ako stará appka's `fetch is _DEFAULT_FETCH`** — test naň (nikdy live
  sieť) potrebuje `vi.stubGlobal("fetch", ...)` PLUS `sleep` injektovaný
  cez `SearchClientOptions.sleep` (fetcher sa necháva na predvolený
  `nativeFetcher`, aby identity-check prešiel) — pozri `client.test.ts`'s
  "throttles 700ms" test. Injektovaný fake `Fetcher` (bežný prípad vo
  väčšine testov) throttle VYNECHÁVA úplne, aj keď `throttleMs`/`sleep` sú
  nastavené — to je zámer, nie diera.
- **Diagnostická technika: keď `grep`/`Edit`'s string-match ticho nenájde
  reťazec, ktorý v súbore PREUKÁZATEĽNE JE (`Read` ho ukáže)** — over
  najprv, či súbor neobsahuje skutočný NUL bajt (`python3 -c "print(b'\x00'
  in open(cesta,'rb').read())"`); `grep` bez `-a` traktuje takýto súbor
  ako binárny a ticho nič nevráti (žiadna chyba, len prázdny výstup), aj
  keď `head`/`cat`/`wc -l` fungujú normálne. Vzniklo tu autorskou chybou
  pri skladaní obsahu nástroja `Write` (zamýšľaná medzera sa zapísala ako
  NUL) — oprava je priamy binárny `read().replace(b"\x00", b" ")`, nikdy
  prepis celého súboru odhadom správneho obsahu.
- **Cookie header pre retry v `fetchWithRetry` sa MUSÍ stavať NANOVO pred
  KAŽDÝM pokusom, nikdy raz vopred pred celou slučkou** — pôvodná
  implementácia dostávala `headers: Record<string,string>` ako HOTOVÝ
  objekt (postavený RAZ, pred prvým pokusom), takže cookie uložená do
  cookie jaru PO neúspešnom 1. pokuse (napr. session cookie vydaná spolu
  s 503) sa na 2. pokus vôbec nedostala — `headers` bol zmrazený snímok
  spred jej príchodu. Fix: `buildHeaders: () => Record<string,string>`
  (factory, volaná vnútri `for` slučky pred KAŽDÝM `rawFetch`), nie
  statický objekt. **Nájdené VLASTNÝM regresným testom pri prvom behu**
  (`client.test.ts`'s "captures a Set-Cookie carried on a FAILED attempt")
  — presne dôkaz, že aj pri doslovnom porte s vysokou dôverou treba
  regresný test na KAŽDÉ tvrdenie o správaní, nielen na tie, čo pôsobia
  rizikovo. Rovnaký test pri ĎALŠOM stavovom fetcheri/retry mechanizme v
  appke: ak sa hlavičky/stav menia MEDZI pokusmi tej istej operácie,
  over explicitne, že KAŽDÝ pokus číta AKTUÁLNY stav, nie stav zachytený
  pred prvým pokusom.
- **WHATWG `URL` konštruktor je PRÍSNY parser, na rozdiel od Pythonovho
  zhovievavého `urllib.parse.urljoin`/`urldefrag`** — vyhadzuje na tvaroch
  vstupu, ktoré by Python ticho spracoval (živo overené: `new URL("http://
  [", base)` aj `new URL("http://exam ple.com/x", base)` obe vyhodia
  `TypeError: Invalid URL`). Pri DOSLOVNOM porte kódu, ktorý v Pythone
  nikdy nepotreboval per-item try/except (lebo `urljoin` jednoducho
  nevyhadzuje), preto TREBA pridať izoláciu, ktorú Python nemal — inak
  JEDNA pokazená karta na živej stránke zhodí `.each()` slučku a zahodí aj
  všetky OSTATNÉ platné kandidáty (review nález, issue 387 E2). Riešenie
  tu: `resolveAndStripFragment` (`adapters/url.ts`) vracia `string | null`
  namiesto vyhodenia — volajúci (KAŽDÝ z troch adaptérov) kontroluje
  `null` presne tak, ako už kontroluje prázdny `href`. Test pri KAŽDOM
  ĎALŠOM 1:1 porte Python kódu, ktorý sa spolieha na `urljoin`/`urldefrag`/
  iné zhovievavé parsovanie: over, či JS/TS ekvivalent (`URL`,
  `URLSearchParams`, ...) vyhadzuje na rovnakých vstupoch — ak áno, obal
  ho tak, aby zlyhanie JEDNÉHO záznamu nezhodilo celý dávkový cyklus.

## E3 — DB + gather job (`run.ts`, `select.ts`, `schema-pairing-review.ts`)

- **`gather_candidates` (top-K review, `query_variants` union), NIE
  `match_one` (priamy CSV-import match, `query_ladder` sekvenčný fallback)
  — stará appka MALA obe funkcie a robia rozdielne veci.** `matcher.py`'s
  `match_one` sa zastaví na PRVOM dopyte, čo vrátil kandidátov. `gather_
  candidates` (k=8) skúša VŠETKY dopyty, poolu je kandidátov podľa URL
  naprieč nimi a vráti top-K — TOTO je funkcia, ktorú nová appka's top-8
  review obrazovka reálne portuje (návrh: „top-K = 8, únia všetkých
  query_variants"). Zadanie tejto etapy malo skratkovité „query ladder →
  SearchClient", čo je nepresné — `run.ts` používa `buildQueryVariants`,
  nikdy `buildQueryLadder`. Test pri KAŽDOM ďalšom porte funkcie zo starej
  appky, ktorá má VIAC príbuzných variantov (napr. E4's `verify.py` môže
  mať podobný pár): priamo v zdrojáku over, KTORÁ funkcia zodpovedá
  cieľovému správaniu, nikdy neodvodzuj z podobného mena.
- **`suppliers` (schema-pairing.ts, F4/#44) UŽ EXISTOVALA, prázdna — E3 ju
  len naplnila.** Migračný seed je `ON CONFLICT (name) DO UPDATE SET
  adapter_key=…, wholesale_base_url=…` (nie `DO NOTHING`) — keby riadok pre
  daného dodávateľa už niekedy vznikol ručne, tento seed ho DOPLNÍ, nikdy
  nezduplikuje. `currency` sa pri konflikte nemení. Rovnaký vzor pri
  KAŽDOM ďalšom "existujúca tabuľka konečne dostane obsah" seede.
- **`product.supplier` (Shoptet-ov voľný text) je case/whitespace-
  insensitívny kľúč do `suppliers.name` — existujúci `orders/supplier-
  key.ts`'s `normalizeSupplierKeyJs` (predtým len pre dodávateľské
  zoskupenie objednávok) je PRESNE tá istá normalizácia, čo potrebuje
  párovací výber.** Produkt, ktorého `product.supplier` nesedí so ŽIADNYM
  `suppliers` riadkom s vyplneným `adapter_key`, sa gatherom NIKDY
  nevyberie — presne ako stará appka spracovávala VÝHRADNE (supplier,
  pairCode) skupiny patriace jej trom `config.SUPPLIERS` (`csv_loader.py`'s
  `load_rows(path, suppliers)` filter), nikdy celý katalóg.
- **Checkpoint = per-produkt TRANSAKČNÝ upsert (delete+insert kandidátov +
  candidate_set upsert v JEDNEJ transakcii), ŽIADNA cursor tabuľka.**
  Obnoviteľnosť po páde príde ZADARMO z `input_hash`: produkt už
  committnutý v predošlom (spadnutom) behu má `input_hash` zhodný so svojím
  aktuálnym stavom → `select.ts` ho ďalší beh sám preskočí. Zamietnutá
  alternatíva (design komentár na tickete): samostatná cursor tabuľka —
  menej stavu bez nej, žiadne riziko neplatného kurzora pri zmene eligible
  množiny medzi behmi.
- **Časový (nie počtový) strop behu** — na rozdiel od `restock`'s
  `MAX_PER_RUN` (počet zápisov do CUDZIEHO systému) je gatherov nákladový
  faktor SIEŤOVÝ ČAS na produkt (viac `query_variants` × throttle 0,7s ×
  až 3 retry), ktorý sa medzi produktmi výrazne líši — počtový strop by
  negarantoval predvídateľnú dĺžku behu. `RUN_TIME_BUDGET_MS` sa
  kontroluje PRED každým ďalším produktom (nikdy uprostred jeho
  transakcie); `clock`/`timeBudgetMs` sú injektovateľné pre testy —
  deterministický test vynúti "spracuj presne 1 produkt, potom stop"
  sekvenciou vopred pripravených návratových hodnôt `clock()` (`[0, 0,
  1000]` s `timeBudgetMs: 1` — prvé volanie = deadline výpočet, druhé =
  pred-item0 kontrola < deadline, tretie = pred-item1 kontrola ≥ deadline).
- **REVIEW NÁLEZ (🔴, opravené pred mergom): nový advisory zámok kľúč
  KOLIDOVAL s existujúcim, lebo `.claude/rules/scheduler.md`'s vlastný
  registr bol zastaraný.** Návrh aj zadanie E3 menovali `787_878_007` ako
  "voľný" — v skutočnosti už mesiace patril `SUPPLIER_STOCK_RUN_LOCK_KEY`
  (`supplier-stock/constants.ts`, issue 212), ale registr v `scheduler.md`
  ho (spolu s `restock`'s `008`) NIKDY nezaznamenal. Oba sú session-scoped
  `pg_advisory_lock` — kolízia by znamenala BEZČASOVÉ vzájomné zablokovanie
  dvoch nesúvisiacich behov. Oprava: `787_878_009`, registr doplnený.
  **Test pri KAŽDOM ďalšom advisory zámku: never dôveruj číslu z návrhu/
  zadania naslepo — `grep -rn "787_878_0" apps/api/src` PRIAMO v kóde je
  jediný spoľahlivý zdroj pravdy, playbook je len pomôcka a môže zaostávať.**
- **`pairing_candidate.raw_score` je `numeric` (string na JS strane), nie
  `real`/`doublePrecision`** — v CELEJ appke sa floaty ukladajú VÝHRADNE
  cez `numeric` (peňažné polia), žiadny natívny float typ sa nikde
  nepoužíva. `rawScore` (number z `ranking.ts`) sa pri zápise konvertuje
  `.toFixed(4)`.

## E4 — Verify + auto-výber (`verify.ts`)

- **`verify.py`'s `code_verdict`/`extract_page` NEBOLI volané zo starej
  appky's hlavného pipeline (`matcher.py`) vôbec** — grep celého `src/`
  ukázal jediné volania z `webreview/app.py` (len title, live náhľad) a z
  testov. Skutočným účelom bola pravdepodobne príprava pre externý AI-
  verifikačný krok, ktorý sa NEportuje (design komentár, sekcia 5,
  posledný odsek — "voliteľné neskôr"). Táto appka repurpose-uje presne
  TÚ ISTÚ kaskádu ako AUTOMATICKÝ (ne-AI) OK/UNSURE gate priamo nad
  `pick_best()`'s `chosen_url`. Test pri porte ĎALŠEJ funkcie zo starej
  appky: over `grep`om, KTO ju reálne volá v `src/`, nikdy nepredpokladaj
  účel len z jej mena/umiestnenia — dva rôzne, podobne znejúce
  "verifikačné" mechanizmy (AI-krok vs. deterministický kód-gate) môžu
  zdieľať tú istú portovanú funkciu s úplne iným volajúcim kontextom.
- **ODIMON (BUXUS) NEMÁ vlastný kódový selektor v starej appke — žiadna
  fixtúra, generický fallback (`[itemprop=sku]`/`.product-code`/`.sku`/
  `.kod`/`[data-code]`) na živej stránke NIČ netrafí.** Živo overené
  13. 8. 2026: skutočný markup je `<li class="product-property-item">
  <span class="product-property__title">Kód produktu:</span><span
  class="product-property__value">PO22811</span></li>` — úplne iná
  trieda selektorov než WETLAND (`.detail__title`/`.detail__right`) aj
  BETALOV (`.fs-5` regex). `verify.ts` preto pridáva ŠTVRTÝ kaskádový
  krok (`.product-property-item` → `.product-property__title` obsahujúce
  "kód" → `.product-property__value`), zaradený PRED generický fallback —
  toto je NOVÝ krok mimo doslovného portu, nie chyba pri kopírovaní.
  Zdôvodnené v design komentári na tickete ako technické rozhodnutie
  (žiadny používateľský dôsledok sa nemení — stále len OK/UNSURE, nikdy
  false-ok), nie majiteľova otázka. Test pri PORTE ĎALŠIEHO Python
  kódu, ktorého docstring/komentár tvrdí "generický fallback pokrýva
  zvyšok" bez fixtúry pre KAŽDÉHO dodávateľa: over živo proti REÁLNEJ
  stránke KAŽDÉHO dodávateľa, ktorého sa to týka — "generický" nemusí
  znamenať univerzálny, len že autor nenašiel čas/dôvod na vlastný krok.
- **Cheerio's `??` reťazec na `.attr()`/`.text()` fallbacku sa RÔZNI od
  Pythonovho `or` — `or` padá na ĎALŠÍ zdroj aj pri PRÁZDNOM (nie len
  chýbajúcom/None) reťazci, `??` len pri `null`/`undefined`.** Review
  nález (issue 387 E4): `el.get("content") or el.get("data-code") or
  el.get_text(...)` (Python) vs. pôvodné `el.attr("content") ??
  el.attr("data-code") ?? el.text()` (TS) — `content=""` by v TS verzii
  celú cestu zastavilo namiesto skúsenia `data-code`/textu na TOM ISTOM
  elemente. Fix: `||` namiesto `??` pre TENTO KONKRÉTNY vzor ("skús
  viacero zdrojov, prvý NEPRÁZDNY vyhráva") — `pnpm lint` ostal čistý
  (`@typescript-eslint/prefer-nullish-coalescing` je type-aware a na
  potenciálne prázdnom `string` type `||` nehlási). Test pri KAŽDOM
  ĎALŠOM porte Pythonovho `a or b or c` vzoru na string hodnoty (nie
  booleans/objekty): `||` je SPRÁVNY preklad, `??` je TICHÁ zmena
  správania pri prázdnom (nie chýbajúcom) reťazci.
- **Funkcia, ktorej DOKSTRING sľubuje "sieťová AJ parse chyba sa nikdy
  nevyhodí ďalej", musí mať OBE kroky v JEDNOM `try`/`catch` — try len
  okolo fetchu, dokstring sľubujúci aj parse-bezpečnosť, je TICHO
  nepravdivý.** Review nález: pôvodná `verifyCandidateCode` mala
  `try { html = await fetch(...) } catch {...}` a `codeVerdict(extractPage(
  html))` AŽ ZA týmto blokom (mimo try) — parse-krokový throw (cheerio/
  regex) by prešiel cez `verifyPickIfWarranted` až do `run.ts`'s
  per-produkt `try`, čo by zahodilo CELÝ gathered candidate set daného
  produktu (nielen krok overenia) až do ďalšieho nočného behu. Fix: jeden
  spoločný `try` okolo fetch AJ `extractPage`/`codeVerdict`. Test pri
  KAŽDEJ ĎALŠEJ funkcii s podobným "nikdy nezhodí volajúceho" sľubom vo
  vlastnom dokstringu: over, že KAŽDÝ krok, ktorý dokstring menuje, je
  SKUTOČNE vnútri chráneného bloku — nie len ten najzrejmejší (sieť).
- **`SearchClient.fetchPage(url)` (NOVÁ verejná metóda) zdieľa `this.
  fetcher` (per-host cookie jar + retry + warm-up) aj throttle-if-real
  logiku so `.search()`, ZÁMERNE nie samostatný fetcher z `supplier-
  stock/page-fetcher.ts`.** Dôvod: kandidátova detailná URL je na TOM
  ISTOM hoste ako search výsledky, a Nette (BETALOV)/BUXUS (ODIMON)
  vyžadujú platnú session cookie pre OBOJE — zdieľaný fetcher profituje
  zo session už zohriatej `.search()` volaniami v tom istom gather
  cykle, samostatný `supplier-stock`-štýl fetcher (bez cookie jaru) by
  musel host znova warm-upovať a strácal by session medzi search a
  detail fetchmi. Bez cache (na rozdiel od `.search()`) — detailná URL
  je vždy jedinečná, cache by nikdy nehitla.

## E5 — Obrazovka Párovanie, čítanie (`pairing-review/`, `PairingReviewSection.tsx`)

- **Populácia je "produkty S `pairing_candidate_set` riadkom" (INNER JOIN),
  nie "produkty vhodné na gather".** `pairing-search/select.ts`'s
  `selectEligibleProducts` (E3) rieši ÚPLNE inú otázku ("koho má gather
  ešte spracovať/prespracovať") — E5's `listPairingReview` (`pairing-review/
  queries.ts`) nad tým NESTAVIA, číta VLASTNÝ, jednoduchší dopyt priamo z
  `pairing_candidate_set`. Produkt, ktorý nočný beh ešte nikdy nezbieral, sa
  na tejto obrazovke nezobrazí vôbec — to je ZÁMER (zadanie: "zoznam
  produktov S kandidátmi"), nie chyba/medzera.
- **`pairing_decision` (E6) v čase E5 EŠTE NEEXISTUJE — "Nezrevidované"
  filter/odznak/progress preto NIE JE "chýba rozhodnutie", je to "chýba
  EFEKTÍVNA dodávateľská linka"** (`resolveEffectiveSupplierLink`, tá istá
  funkcia ako `product-links`/`restock-links`, zohľadňujúca AJ
  `product_supplier_link_override` AJ `internalNote`). Design komentár na
  tickete (issue 387 E5) toto rozhodnutie explicitne zdôvodňuje a
  poznamenáva, že E6 môže tento predikát ĎALEJ zúžiť (napr. vylúčiť produkty
  rozhodnuté `unavailable`/`discontinued`) BEZ zmeny API kontraktu ani tejto
  obrazovky — pri práci na E6 over najprv, či `unreviewed`'s SQL/JS predikát
  v `queries.ts` ešte zodpovedá aktuálnemu zámeru, než sa píše nová logika
  vedľa neho.
- **`matched`/`unmatched` = `pairing_candidate_set.chosen_url !== null`,
  NIKDY `confidence !== "none"` priamo** — funkčne rovnaké (`ranking.ts`'s
  `pickBest()` vracia `confidence: "none"` PRÁVE VTEDY, keď `candidates.length
  === 0`, teda `chosen_url` je vtedy vždy `null`), ale `chosen_url` je
  priamy, jednoznačný stĺpec bez potreby poznať `pickBest()`'s vnútorné
  správanie — over TOTO tvrdenie priamo v `ranking.ts` pri KAŽDEJ ďalšej
  zmene `pickBest()`u, nie len tu v playbooku.
- **Naša strana karty (`ourUrl`/`ourImageUrl`) ide cez `shop_product_url`
  spárovaný podľa KTORÉHOKOĽVEK kódu variantu produktu** (deterministicky —
  najmenší kód vyhráva pri viacerých zhodách, rovnaký vzor ako
  `nedostupne/resolve-products.ts`'s `findMatchingCode`), fallback na
  `…/vyhladavanie/?string=<meno>` presne ako stará appka. Meta (cena/sklad)
  je rozsah (`priceMin`/`priceMax`) naprieč VŠETKÝMI variantmi produktu — na
  rozdiel od starej appky (jeden variant = jeden riadok) môže mať produkt
  tejto appky viac cien naraz.
- **Kandidátova strana ukazuje LEN `chosenUrl`, nikdy celých top-8.**
  Rozbaľovací panel so všetkými kandidátmi (výber jedného, manuálne URL) je
  E6-ova ROZHODOVACIA UI (design komentár, sekcia 3) — E5 je explicitne "BEZ
  akčných tlačidiel". Lazy live-fetch meta endpoint (analóg starej appky's
  `/api/images`) bol pre E5 ZÁMERNE preskočený (technické rozhodnutie, nie
  medzera) — všetko, čo karta potrebuje (meno/URL/skóre/istota/verdikt), je
  už persistované z E3/E4; ak E6's rozhodovací panel skutočne potrebuje
  živú cenu/obrázok kandidáta, TAM sa má live-fetch pridať, nie predtým.
- **Worktree založený PRED tým, než predchádzajúca etapa domergovala do
  `dev`, obsahuje STARÝ kód bez nej — `git status`/`git log origin/dev..HEAD`
  prázdne NEZNAMENÁ "som na aktuálnom stave dev", znamená len "moje commity
  sú podmnožinou origin/dev-u v čase FETCHU".** E5's worktree bol založený
  na E3's merge bode (`a6c0c10`/`d031c27`) TESNE PRED tým, než E4's
  round-integrácia dobehla (`4a0707b`, `origin/dev` verzia `0.3.0-dev.229`) —
  dispatch prompt správne hlásil "dev = .229", ale worktree samo malo ešte
  `.228` a ANI JEDEN E4 súbor (`verify.ts`, zapojenie do `run.ts`). Bez `git
  merge origin/dev` PRED prvým commitom by E5 stavalo na E1-E3 kóde a E4's
  zmeny (najmä `pairing_candidate_set.verdict`, ktorý E5 priamo zobrazuje)
  by chýbali z worktree úplne, hoci sú dávno zmergované. **Pri KAŽDEJ ĎALŠEJ
  etape tejto sériovej reťaze (E6-E9): PRED prvým riadkom kódu vždy `git
  fetch origin && git log HEAD..origin/dev --oneline` — ak nie je prázdne,
  `git merge origin/dev` PRED verziovým bumpom**, presne ako predpisuje
  autopilot-workerov vlastný CYCLE krok 1 ("RESUME, don't restart") — v
  paralelnom worktree-dispatchi (issue #317) je to bežný, nie výnimočný
  prípad, keďže susedná etapa sa mohla domergovať PO založení tohto
  worktree, ale PRED začiatkom skutočnej práce naň.
- **Substring/accessible-name kolízia s BADGE odznakom** (nová viditeľná
  záložka, ktorej meno je prefixom existujúcej, A ZÁROVEŇ nesie odznak počtu)
  — plný mechanizmus a fix zdokumentovaný v `.claude/rules/frontend-
  design.md` (hľadaj "nav-tab-"), nie duplikovaný tu.
- **Nová e2e fixtúra (`scripts/e2e-fixtures-pairing-review.ts`, PR pre issue
  387 E5) zhodila 4 EXISTUJÚCE testy v `catalog.spec.ts` — spadla len preto,
  že vlastný `pairing-review.spec.ts` prešiel izolovane pri prvom overení,
  nikdy sa nespustil CELÝ balík pred pushom.** Tri nové produkty
  (`E2E-PR-CHYBA`/`E2E-PR-NENAJDENY`/`E2E-PR-SLINKOU`) sú `state: "sellable"`,
  `productVisibility: "visible"` — presne tá istá trieda ako issue 217/337
  (`.claude/rules/testing.md`'s "Pridanie čo i len JEDNÉHO variantu do e2e
  seedu posunie pevné počty v `catalog.spec.ts`"): total `103→106`, filter
  "sellable" `72→75`, "missing"(1) nezmenené (žiadny z troch je `missing`).
  Zvolené riešenie je AKTUALIZÁCIA pevných počtov (precedens issue 337), nie
  izolácia — celkový počet by sa musel zvýšiť aj tak (nové produkty MUSIA byť
  reálne katalógové varianty, inak by pairing-review populácia — INNER JOIN
  na `pairing_candidate_set` — nemala čo zobraziť), takže "izolovať od
  catalog počtov" nie je pre TOTAL nikdy možné, len pre "sellable" filter.
  **Test na KAŽDÚ ĎALŠIU novú e2e fixtúru vyčlenenú do vlastného súboru
  (vzor `seedXFixtures`, `scripts/e2e-setup.ts`): spusti CELÝ e2e balík
  (`pnpm --filter @forestshop/web e2e`), nikdy len vlastný nový spec súbor —
  presne rovnaká past ako `aria-label`/`getByRole`/nav-záložka kolízie
  zdokumentované v `.claude/rules/testing.md`, len tentoraz cez ZDIEĽANÝ
  POČET namiesto zdieľaného selektora.**

## E6 — Rozhodnutia (`pairing-review/decisions.ts`, `pairing_decision`, `PairingReviewCard.tsx`)

- **Guard proti súbežnému prepisu je "posledný zápis vyhráva"
  (`onConflictDoUpdate`), NIE optimistický zámok** — design komentár na
  tickete (issue 387 E6) zvažoval aj `updated_at` round-trip aj
  `SELECT ... FOR UPDATE`, oboje zamietnuté ako zbytočná zložitosť pre
  nízkofrekventovanú ručnú akciu bez precedensu v appke. `decided_at`/
  `updated_at` stĺpce napriek tomu existujú OBIDVA (vždy tá istá hodnota v
  tejto verzii) — čisto ako príprava, keby to niekedy bolo treba zmeniť bez
  ďalšej migrácie. Konflikt sa NIKDY nepredchádza, len sa SPÄTNE zaznamená
  do auditu (`previousStatus`/`previousUrl`) — rovnaký princíp ako
  `upsertProductSupplierLink` už dnes robí pre samotnú linku.
- **`upsertProductSupplierLink` (`orders/supplier-link-assignment.ts`, #239)
  dostalo `export` — jediná zmena existujúceho súboru, čisto aditívna.**
  Dôvod: `setPairingDecision`'s `good`/`manual` vetva potrebuje zapísať
  `pairing_decision` AJ `product_supplier_link_override` v JEDNEJ
  transakcii, ale `setProductSupplierLinkForProduct` (existujúci wrapper)
  SAMA otvára `db.transaction(...)` — vnorená transakcia by nefungovala.
  Zdieľané jadro (`upsertProductSupplierLink`, prijíma `UpsertExecutor` =
  `Pick<Database, "select"|"insert">`) sa preto volá PRIAMO s VLASTNÝM `tx`.
  Rovnaký vzor pri KAŽDEJ ďalšej potrebe "spoj DVA existujúce zápisy do
  jednej transakcie": exportuj zdieľané JADRO (nie wrapper), nikdy nevnáraj
  `db.transaction` do `db.transaction`.
- **"unreviewed" (E5's `!hasEffectiveLink`) sa E6 NEZUŽUJE naivne na "žiadne
  rozhodnutie vôbec"** (to bol starej appky's doslovný `status === null`) —
  produkt s efektívnou linkou ZALOŽENOU MIMO tejto obrazovky (napr. cez
  "Párovanie produktov" #239 predtým, než sa naň niekedy rozhodlo tu) sa
  bez rozhodnutia stále počíta ako "má odkaz, netreba naň upozorňovať".
  Skutočná zmena: `unreviewed` = `!hasEffectiveLink && !(decision existuje
  && status IN (unavailable, discontinued))` — TERMINÁLNE rozhodnutia
  (čo linku NIKDY nedostanú) sa vyradia AJ bez linky, `good`/`manual` sú už
  vyradené cez prvú podmienku (vždy majú linku). Over toto pri KAŽDEJ ďalšej
  úprave predikátu — doslovný port starej appky by tu bol TICHO nesprávny.
- **"↩ Vrátiť" NIKDY nemaže `product_supplier_link_override`** (dizajnové
  rozhodnutie, design komentár na tickete) — dôsledok je ASYMETRIA, ktorú
  treba poznať pred ďalšou zmenou: revert `unavailable`/`discontinued`
  (žiadna linka) VRÁTI produkt do "unreviewed" (presne "Vrátiť vracia do
  nezrevidovaných", zadaniev akceptácia). Revert `good`/`manual` NEVRÁTI —
  linka naďalej existuje, takže produkt zostáva MIMO "unreviewed" (nájditeľný
  cez "Všetky"/"Napárované", už bez odznaku/rozhodnutia). Toto NIE JE bug —
  je to priamy dôsledok E5's vlastnej `unreviewed` definície (bez linky), nie
  "bez rozhodnutia". Integračný test `pairing-review-decisions-http
  .integration.test.ts` dokazuje OBE vetvy explicitne oddelene.
- **`GET /:productKey/candidates` je LAZY (fetchne sa AŽ pri otvorení panelu
  "✗ Zlé"/"✗ Zmeniť"), nikdy vložené do hlavného `GET /api/pairing-review`
  zoznamu** — E5 už zamietla živý meta-fetch (obrázok/cena) ako zbytočnú
  záťaž; E6 pridáva len malý endpoint nad UŽ perzistovanými `pairing_
  candidate` riadkami (meno/URL/skóre/kód-zhoda), volaný len keď ho
  reviewer skutočne potrebuje. Vloženie všetkých top-8 do KAŽDEJ položky
  zoznamu by zbytočne nafúklo payload kariet, čo sa nikdy nerozbalia.
- **Karta (`PairingReviewCard.tsx`) je od E6 STAVOVÁ, ale panel/busy/
  candidates stav je PER-KARTE lokálny `useState`, nikdy globálny scalar**
  (na rozdiel od `DailyTasksSection.tsx`'s `editingXId` vzoru, ktorý issue
  381 dokumentuje ako past — `.claude/rules/frontend-design.md`). Viac
  kariet smie mať panel otvorený súčasne bez kolízie, jeden zdieľaný `busy`
  guard na karte blokuje VŠETKY jej vlastné akčné tlačidlá naraz. Po
  úspešnom zápise sa NEROBÍ optimistický lokálny update poľa `item` —
  `PairingReviewSection`'s `onDecided` prop znova načíta AKTUÁLNY filter na
  stranu 1 zo servera (jediný zdroj pravdy, žiadna duplicitná klientská
  filter-logika).
- **Farba odznaku rozhodnutia (`pairing-review-decision-<status>`) je PODĽA
  STATUSU, nie jedna pevná farba pre všetky štyri** (review nález) —
  `good`/`manual` zelená (`--fs-success`), `unavailable` žltá
  (`--fs-warning`, dočasný/re-kontrola), `discontinued` sivá
  (`--fs-surface-alt`/`--fs-ink-muted`, konečný) — rovnaký princíp ako
  `.pairing-review-state-*` (produkt stav Skladom/Nie je skladom/Ukončené).
- **Plný lokálny e2e beh (nie len kolízna dvojica pairing-review+nav) pri
  E6 objavil PREDOŠLÚ (E5) medzeru** — `catalog.spec.ts`'s natvrdo napísané
  počty (103/72) nikdy nezohľadnili E5's 3 nové sellable varianty
  (`E2E-PR-CHYBA`/`NENAJDENY`/`SLINKOU`), presne ten "pridanie jedného
  variantu do e2e seedu posunie pevné počty" gotcha z `.claude/rules/
  testing.md`. Oprava (106/75) je v E6's PR, mimo E6's vlastného kódu.
  **Poučenie pre KAŽDÚ ĎALŠIU etapu tejto sériovej reťaze:** spustiť PLNÝ
  lokálny e2e beh aspoň RAZ za pár etáp (nielen kolíznu dvojicu) — kolízna
  dvojica chytá len PRIAME substring/aria kolízie, nikdy vzdialené číselné
  závislosti ako `catalog.spec.ts`'s celkový počet.

## E7 — Stavový writeback (`shoptet-writeback/{csv,select-states,mark-state-synced,run-state-writeback,run-writeback-sequence,state-writeback-settings}.ts`)

- **`variants.code` je v tejto appke DB PRIMÁRNY KĽÚČ (`schema-catalog.ts`)
  — starej appky's "dedup podľa code, first-wins" zákon je tu preto
  ŠTRUKTÚROVANE nedosiahnuteľná situácia pri korektnom volajúcom, nikdy
  reálna možnosť ako v starej appke (kde CSV-grouping raw Shoptet exportu
  vedel produkovať skutočné duplikáty naprieč "produktmi").**
  `dedupeStateRowsByCode`/`buildStatesCsv` napriek tomu implementujú dedup
  doslovne (zadanie to explicitne žiada + je to obranná vrstva navyše) —
  ale nikdy sa naň nespoliehaj ako na JEDINÚ ochranu proti duplicitnému
  `code` v CSV; skutočná ochrana je DB unikátnosť. Pri ĎALŠOM porte
  "dedup/first-wins" pravidla zo starej appky do tejto appky vždy over
  najprv, či cieľový stĺpec tu má DB unikátnosť — ak áno, dedup kód je len
  dokumentácia zámeru/obranná vrstva, nie skutočná nutnosť.
- **Read-back kontrola bezpečných nastavení importu (`_ensure_safe_settings`
  starej appky) UŽ existovala pred E7** — `playwright-import.ts`'s
  `ensureSafeSettings` (zavedená issue 122) nastavuje AJ číta späť oba
  prvky (`.isChecked()` po `.check()`/`.uncheck()`, abort pri nezhode) a je
  zdieľaná KAŽDÝM importom cez `runShoptetImportIsolated` (linkový aj
  stavový). Zadania bod "doplniť, ak chýba" bol teda "over, nie doplň" —
  potvrdené v design komentári na tickete PRED kódovaním, nikdy netreba
  znova písať/kontrolovať pri ĎALŠOM novom CSV type v tomto module.
- **Sekvenčná nezávislosť dvoch Playwright importov v jednom scheduler
  behu potrebuje VLASTNÝ `try`/`catch` v KAŽDOM podbehu** — plný
  mechanizmus + review nález (`e6c2695`) zdokumentovaný v `.claude/rules/
  shoptet-writeback.md` (hľadaj "VYHADZUJE"), nie duplikovaný tu.
