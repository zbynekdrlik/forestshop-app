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

## E8 — Vyradenie #311 (`restock-links` — modul, route, screen, api, nav, badge, e2e, rule súbor)

- **Odstránenie fixtúrových produktov posúva pevné e2e počty PRESNE
  SYMETRICKY k ich pridaniu** — `.claude/rules/testing.md`'s
  zdokumentovaná pasca ("pridanie jedného variantu do e2e seedu posunie
  pevné počty v `catalog.spec.ts`") platí aj naopak: odstránenie
  `scripts/e2e-fixtures-restock-links.ts` (3 produkty, 2 `sellable`)
  posunulo `catalog.spec.ts`'s `Nájdených:` 106→103 a filter "sellable"
  75→73, `nav.spec.ts`'s dve `toHaveCount` asercie záložiek 21→20,
  `nav.test.ts`'s `NAV[3].tabs` 5→4. Aritmetika sa NEODVODZUJE z pamäte
  ticketu — prečítaj ODSTRAŇOVANÚ fixtúru (kým ešte existuje, `git show
  HEAD^:<súbor>` ak už zmazaná) a spočítaj presne, koľko produktov/z toho
  koľko `sellable`, PRED úpravou čísel.
- **Design komentár tvrdil "badge sa presmeruje na nový počet" — v
  skutočnosti sa má len ODSTRÁNIŤ, keďže cieľová obrazovka (E5, "Párovanie")
  UŽ MÁ vlastný nezávislý odznak (`pairingReviewUnreviewedCount`) od svojej
  vlastnej etapy.** Žiadne prepojenie/presmerovanie netreba — `App.tsx`'s
  starý `restockLinksMissingCount` stav/efekt/`useCallback`/Context
  Provider (vrátane JSX wrapperu, ktorý treba správne od-indentovať/
  vyvážiť) sa jednoducho vymaže celý. Overuj DESIGN VETY o "presmerovaní"
  proti aktuálnemu kódu pred písaním — návrh mohol vzniknúť skôr, než
  cieľová funkcionalita (tu E5's vlastný odznak) existovala.
- **Overenie "táto zmena sa NEDOTKLA susednej/podobne pomenovanej
  automatiky" (tu: #212/#213 "Vypredané → Skladom", zdieľa miesto v menu aj
  prefix mena s odstráneným #311) ide najspoľahlivejšie cez `git diff
  <base> <head> -- <cesty-suseda>` vrátený PRÁZDNY, nie len "jeho testy
  prešli"** — testy prejdú aj keď je súbor nedotknutý ALEBO keď sa
  zhodou okolností správa rovnako; prázdny `git diff` na konkrétne súbory
  (`RestockSection.tsx`, `restock`/`supplier-stock` moduly,
  `restock-waiting.spec.ts`/`restock-events.spec.ts`) je priamy dôkaz.
  Použi rovnaký vzor pri E9 (vyradenie starého #239 UI + F4) na dôkaz, že
  `/api/product-links` route a jej zapisovacia cesta ostali nedotknuté.

## issue 397 — Obrázok kandidáta na karte (mimo E1-E9 sériovej reťaze)

- **Stará appka NIKDY neparsovala kandidátov obrázok z výsledkovej karty —
  ťahala ho AŽ naživo z DETAILU (`og:image`, LEN pri otvorení karty vo
  webreview, disk-cache).** Dispatch predpokladal opak; skutočnosť je
  LEPŠIA — živé overenie (curl + cookie warm-up, 13. 8. 2026) ukázalo, že
  VŠETKY TRI dodávateľské výsledkové karty DNES reálne obrázok nesú, len
  ho žiadny parser doteraz nečítal. `PairingCandidate.imageUrl` sa preto
  pľní PRIAMO v E2's adaptéroch (žiadny extra network request), s `og:image`
  fallback (`verify.ts`) len ako defenzívna posledná záchrana pre CHOSEN
  kandidáta, keď E4 aj tak beží (confidence high/medium).
- **Per-dodávateľ selektor + past, živo overené 13. 8. 2026:**
  - WETLAND: `img.product-miniature__image` v `<picture>` vnútri
    `a.product-miniature__link`, SÚRODENEC (nie predok/potomok) title-
    anchoru — treba `.closest(".product-miniature")` na spoločnú kartu,
    potom `.find(...)`. `data-full-size-image-url` (plná veľkosť)
    uprednostnené pred menším `src`.
  - BETALOV: `img.product-image` v `a.mh-100` vnútri TEJ ISTEJ `.product-col`
    karty, čo už dnes dáva `href` — priamy `card.find(...)`, žiadny
    `.closest()` netreba. **PASCA: jej DETAILNEJ stránky `og:image` je
    VŽDY stránkové logo (`/svg/logo2.svg`), nikdy produkt** — fallback
    preň preto reálne nikdy nič neprinesie (šumový filter ho vyfiltruje),
    zámerne, nie medzera.
  - ODIMON: `img` vnútri `a.product-card`, TEN ISTÝ element, čo už dnes dáva
    `alt`/`title` pre meno. **KRITICKÁ PASCA: `src` je na tejto doméne
    VŽDY `.../no-image.png` placeholder (lazy-load cez JS) — skutočný
    obrázok je LEN v `data-src`.** `resolveImageUrl`'s poradie
    (`data-src` pred `src`) preto nie je štylistická preferencia, je nutná
    správnosť.
- **`resolveImageUrl` (`adapters/url.ts`, zdieľaná adaptérmi AJ `verify.ts`'s
  `og:image` fallbackom) je doslovný port starej appka's `_IMG_NOISE`
  (`webreview/app.py`) — `logo`/`/producer/`/`.svg`/`/svg/`/`placeholder`/
  `no-image`/`banner`/`/img/m/` substring filter (case-insensitive), na
  REZOLVOVANEJ (nie surovej) URL.** Vyberá prvý NEPRÁZDNY, nespracovateľný/
  šumový sa PRESKOČÍ (fallback na ĎALŠIEHO kandidáta v poli, nikdy hneď
  `null`). Test pri KAŽDOM ĎALŠOM dodávateľovi/zdroji obrázka: over živo,
  či jeho "očividný" zdroj (og:image, hlavný `<img>`) nie je v skutočnosti
  logo/placeholder/ikonka — mikrodáta aj obrázky vedia klamať rovnako ako
  `supplier-stock.md`'s dostupnostné JSON-LD.
- **Backfill existujúcich kandidátov BEZ obrázka (1309 riadkov, 177 s
  `chosen_url` v čase merge) je DEDIKOVANÝ idempotentný CLI
  (`backfill.ts` + `cli/pairing-backfill-images.ts` + `scripts/` alias,
  presne vzor `catalog-prune-raw.ts`), NIKDY `input_hash` bump/plný
  re-gather.** Scope = LEN `pairing_candidate` riadky, kde `url =
  candidate_set.chosen_url` (karta ukazuje LEN chosenCandidate, top-8
  panel obrázok nepotrebuje) `AND image_url IS NULL` — jeden
  `SearchClient.fetchPage` na produkt, žiadne query-variant vyhľadávanie
  navyše. Zdieľa `PAIRING_SEARCH_RUN_LOCK_KEY` (žiadny nový kľúč), aby sa
  nikdy nepretínal s nočným gather behom nad TÝMI ISTÝMI riadkami. Príkaz
  na produkcii: `docker compose -f docker-compose.prod.yml exec app node
  apps/api/dist/cli/pairing-backfill-images.js` (bezpečné spustiť
  kedykoľvek znova — WHERE-om idempotentný).
- **Pokrytie NÁŠHO obrázka (`ourImageUrl`, `shop_product_url`) zmerané
  priamo na produkcii (13. 8. 2026): 185 gathered produktov, LEN 28 má
  zodpovedajúci `shop_product_url` riadok (26 s vyplneným obrázkom) — teda
  159/185 (86 %) ukáže na ĽAVEJ strane "bez obrázka".** 157 z týchto 159
  NEMÁ vôbec žiadny `shop_product_url` riadok — presne už zdokumentovaná
  medzera issue 220 (626 viditeľných variantov mimo `google.xml` feedu,
  `.claude/rules/shop-feed.md`), NIE bug tejto appky ani tohto tiketu.
  Zlepšenie by znamenalo vylepšiť Shoptet feed/vyhľadávací fallback —
  samostatný tiket, mimo rozsahu "ukáž oba obrázky".

## issues 398/401/409 — všetky možnosti priamo na karte, plná populácia, obrázky v paneli

- **Populácia obrazovky sa zmenila z "INNER JOIN na `pairing_candidate_set`"
  (E5's pôvodná hranica) na ÚNIU troch množín** (`listPairingReview`,
  `queries.ts`): (1) má `pairing_candidate_set` riadok, ALEBO (2) nemá
  efektívnu dodávateľskú linku, ALEBO (3) má `pairing_decision` riadok.
  Bod (2) je to, čo produkty dodávateľov BEZ automatického adaptéra vôbec
  prvýkrát sprístupní na tejto obrazovke; bod (3) drží produkt viditeľný
  aj POTOM, čo "manual"/"good" rozhodnutie medzitým získa efektívnu linku
  (inak by zmizol skôr, než ho reviewer stihne skontrolovať/zmeniť). Celý
  katalóg sa načíta do JS a filtruje tam (rovnaký MVP vzor ako `select.ts`/
  `product-links`/`restock-links` — `resolveEffectiveSupplierLink` je
  čistá JS funkcia, nedá sa vyjadriť ako SQL predikát bez duplicity).
- **`supplierHasAdapter` (nové pole) je vlastnosť DODÁVATEĽA
  (`suppliers.adapter_key !== null`), NIE vlastnosť "má/nemá gather
  riadok".** Karta ho používa na rozlíšenie "dodávateľ zatiaľ nemá
  automatické vyhľadávanie" (`pairing-review-no-adapter-*`) od "adaptér
  MÁ, gather prehľadal a nič nenašiel" (`pairing-review-no-candidate-*`)
  — pozor, TEORETICKY existuje tretí, nepokrytý stav (adaptérový
  dodávateľ, čo ešte NIKDY negatheroval — `gatheredAt === null` aj
  `supplierHasAdapter === true` naraz), vtedy karta ukáže "Nenašiel sa
  žiadny kandidát" hlášku, hoci presnejšie by bolo "ešte nebehalo" —
  zámerné zjednodušenie (dizajnová poznámka na tickete), keďže nočný beh
  tento stav prakticky vždy vyrieši do 24 h.
- **`withCleanDb()` (integračné testy) AJ `scripts/e2e-setup.ts` (e2e)
  TRUNCATE-ujú `supplier` tabuľku BEZ reseedu migračného WETLAND/BETALOV/
  ODIMON seedu (`0047_brief_yellowjacket.sql`)** — `supplierHasAdapter`
  preto vyjde `false` pre ÚPLNE VŠETKY produkty, pokiaľ si test/fixtúra
  VLASTNÝ `suppliers` riadok sám nevloží. Zavedený vzor (`pairing-search-
  run.integration.test.ts`/`pairing-search-verify.integration.test.ts`,
  teraz aj `e2e-fixtures-pairing-review.ts`): `db.insert(suppliers)
  .values({name, currency:"EUR", wholesaleBaseUrl, adapterKey})` priamo v
  seed/setup kóde — nikdy sa nespoliehaj na migračný seed prežívajúci
  TRUNCATE.
- **Review nález (opravené pred mergom): panel, čo sa ukazuje AUTOMATICKY
  (karta bez kandidáta, nič na "prijatie"), musí SÁM zavolať
  `fetchPairingCandidates` — inak "Načítavam kandidátov…" ostáva navždy
  zobrazené.** Pôvodný E6 kód volal fetch LEN z `openPanel`u (explicitný
  klik "vyber url"/"Zmeniť"), nikdy z auto-show vetvy. Bug existoval od
  E6, ale #401 ho spravil OVEĽA bežnejším (každý produkt bez adaptéra ho
  má). Fix: zdieľaná `loadCandidates()` funkcia + `useEffect` sledujúci
  `item.decision === null && item.chosenCandidate === null` (spustí sa
  PRI MOUNTE aj pri KAŽDOM neskoršom false→true prechode na TEJ ISTEJ
  inštancii — napr. "↩ Vrátiť" na produkte bez kandidáta). **Test pri
  KAŽDOM ďalšom "panel/sekcia sa ukáže bez explicitného kliku" vzore v
  tejto appke: over, či dátový fetch, čo by normálne vyvolal explicitný
  handler, MÁ AJ svoj vlastný `useEffect` spúšťač pre auto-show cestu —
  jeden UI stav vie mať DVA rôzne spôsoby, ako sa zobrazí, a fetch
  potrebuje pokrytie OBOCH.**
- **Nové priame 📦/🚫 tlačidlá (kolektívny riadok na karte, #398) ZDIEĽAJÚ
  `data-testid` s panelovými verziami TÝCH ISTÝCH tlačidiel** (`Terminal
  Buttons`, `PairingReviewPanelParts.tsx`) — bezpečné, lebo obe vetvy sú
  vzájomne VYLUČUJÚCE (priamy riadok len keď `chosenCandidate !== null &&
  decision === null && !panelOpen`, panel len keď `panelOpen || (decision
  === null && chosenCandidate === null)`) — nikdy oba naraz pre ten istý
  produkt. Pri ĎALŠOM podobnom "tá istá akcia na DVOCH miestach karty"
  vzore: zdieľaj testid len PO overení, že podmienky sú GENUINELY
  disjunktné (nie len "vyzerá to tak"), inak dvojznačný Playwright/RTL
  dotaz.
- **Prepínač spätného zápisu stavov NEMÁ UI — zapína sa LEN cez API** (issue
  418, 13. 8. 2026, zapnuté rozhodnutím majiteľa): `PUT /api/pairing-review/
  state-writeback-enabled` s telom `{"enabled": true|false}` (same-origin +
  rola admin/manazer; read-back GET vráti `{"enabled": ...}`). Singleton
  riadok `pairing_state_writeback_settings` id=`default` (upsert). Z
  prihláseného Playwright sedenia stačí `fetch()` v `browser_evaluate` —
  session cookie aj same-origin sú splnené. Ak niekedy pribudne požiadavka
  na vypínač v UI, je to nový ticket (endpoint je hotový, chýba len
  komponent).

## issue 399 — ✂ Rozdeliť na veľkosti + Hľadať/opraviť (mimo E1-E9)

- **`pairing_decision_status` enum + jej CHECK constraint POUŽÍVAJÚCI novú
  hodnotu MUSIA byť DVE SAMOSTATNÉ migrácie, nikdy jedna.** Naživo overené
  na throwaway Postgrese 18: `ALTER TYPE ... ADD VALUE 'split'` a CHECK
  constraint/INSERT používajúci `'split'` v TEJ ISTEJ transakcii vyhodí
  `unsafe use of new value "split" ... New enum values must be committed
  before they can be used` — KEĎ sa príkazy posielajú ako samostatné
  príkazy v transakcii (presne to, čo `drizzle-kit`'s migrátor aj `psql`
  skript robia). Jediný spôsob, ako to naživo prejde v JEDNEJ session, je
  poslať VŠETKY príkazy naraz ako JEDNU multi-statement `simple query`
  protokolovú správu (`psql -c "a; b; c;"`) — nikdy sa na to nespoliehaj,
  to nie je tvar, akým appka migrácie reálne aplikuje. Postup na vyrobenie
  dvoch migrácií z jednej schéma zmeny: dočasne zakomentuj/vráť CHECK a
  novú tabuľku, `db:generate` (dá enum-only migráciu), obnov plnú schému,
  `db:generate` znova (dá zvyšok). Test pri KAŽDEJ ĎALŠEJ novej hodnote
  existujúceho `pgEnum`u, ktorú POUŽIJE aj CHECK constraint/iná DDL v tej
  istej zmene: over TÝMTO postupom na throwaway Postgrese PRED tým, než sa
  jedna migrácia s oboma príkazmi vôbec commitne.
- **Nová `pairing_variant_link` tabuľka (PK `variant.code`) je ÚPLNE
  NEZÁVISLÁ od `product_supplier_link_override` (#121/#239) aj od
  existujúcej `pairing` tabuľky (F4, `schema-pairing.ts`) — design komentár
  na tickete zdôvodňuje OBIDVE zamietnuté alternatívy.** `pairing` (F4)
  vyzerá ako najbližší kandidát na reuse (je UŽ `variant.code`-kľúčovaná,
  má UŽ URL pole) — ale jej dátový model (`navrhnute`/`potvrdene` stavy)
  patrí BUDÚCEMU auto-matching automatu (#46/#48), NIKDY sa nezapisuje do
  Shoptetu, a zlúčenie s "chýbajúce linky" bolo na tickete #239 UŽ RAZ
  explicitne zamietnuté (`.claude/rules/product-links.md`). Reuse `pairing`
  tabuľky pre split by resuscitoval presne to zamietnuté zlúčenie.
- **`isUnreviewed` (queries.ts) MUSÍ zahrnúť `split` do TERMINÁLNEJ vetvy**
  (spolu s `unavailable`/`discontinued`) — split produkt má `hasEffectiveLink
  === false` NAVŽDY (jeho reálne linky žijú v `pairing_variant_link`, nikdy
  v `product_supplier_link_override`), takže bez tejto výnimky by sa NIKDY
  neprestal hlásiť ako "nezrevidovaný" napriek tomu, že JE vyriešený.
- **`getPairingReviewItem`/`buildPairingReviewItems` (jednoproduktová
  verzia `listPairingReview`, "Hľadať / opraviť") je ZÁMERNE SCOPED
  (`inArray`), nikdy nenačíta celý katalóg** — na rozdiel od
  `listPairingReview`'s vlastnej `determineReviewPopulationKeys` (tá MUSÍ
  prejsť celý katalóg, aby zistila populáciu). Refaktor vyčlenil ITEM-
  BUILDING (per-kľúč, scoped) od POPULATION-DETERMINATION (celý katalóg) —
  `listPairingReview` teraz volá OBOJE (najprv určí kľúče, potom postaví
  karty len pre ne), `getPairingReviewItem` volá LEN item-building s
  `[productKey]`. Test pri ĎALŠEJ zmene tejto oblasti: nepridávaj žiadnu
  ďalšiu čítaciu cestu, čo by znova načítala celý katalóg len na
  vyhľadanie JEDNÉHO produktu — scoped dopyt je vždy lacnejší aj správnejší.
- **"Hľadať / opraviť" ZDIEĽA `PairingReviewCard.tsx` NEZMENENÚ** (klik na
  výsledok vyhľadávania → `fetchPairingReviewItem` → tá istá karta, čo
  vidno na "Prehľad") — žiadna druhá kópia rozhodovacej/terminálnej/split
  UI. `GET /api/search` vracia PER-VARIANT riadky (search modul, #240),
  preto `PairingSearchFixTab.tsx` dedupuje podľa `productKey` (prvý výskyt
  vyhráva) predtým, než ich zobrazí — Párovanie je produktovo-úrovňová
  obrazovka, na rozdiel od "Vyhľadať", čo per-variant riadky ukazuje priamo.
- **Karta bola vyčlenená na TRI súbory kvôli eslint `max-lines: 400`**
  (pridanie split trigger + branch by inak `PairingReviewCard.tsx` poslalo
  cez limit, rovnaký vzor ako issue 60/398/409 pred týmto): panel
  (kandidáti/manuál/terminál/Zavrieť) → `PairingReviewDecisionPanel.tsx`
  (čisto presentational, celý stav ostáva v `PairingReviewCard.tsx`); split
  editor → `PairingReviewSplitPanel.tsx` (VLASTNÝ stav — `variants`
  fetchnuté vo `useEffect`, per-riadok `busy`/draft — ale `candidates`/
  `busy`/`submit` dostáva ako props z karty, žiadny druhý fetch top-8
  kandidátov).
- **Split editor NAHRADÍ celú pravú stranu karty** (`showSplitPanel =
  splitOpen || item.decision?.status === "split"`), presne ako stará
  appka's `renderCard`'s `splitOpen.has(p.key) || s === 'split'` early
  return — "Navrhnutý kandidát" blok aj kolektívny riadok akcií SA
  NEVYKRESLIA súčasne so split panelom, nikdy oba naraz.
- **"✂ Rozdeliť na veľkosti" trigger je dostupný VŽDY, keď `item.decision
  === null && item.variantCount > 1`, NEZÁVISLE od toho, či produkt má
  navrhnutého kandidáta** (rovnaký zámer ako stará appky's `splitButton` —
  žiadna podmienka na `chosenCandidate`). Trigger aj "vyber url" zdieľajú
  TEN ISTÝ `loadCandidates()` (žiadny druhý fetch top-8 zoznamu) —
  `openSplit`/`openPanel` sa navzájom VYLUČUJÚ (`setSplitOpen(false)`
  v `openPanel`, `setPanelOpen(false)` v `openSplit`).
- **"↩ Zrušiť rozdelenie" (revert na `split`) NIKDY nemaže per-veľkosť
  linky** (`pairing_variant_link` riadky) — presne rovnaká asymetria/
  konvencia ako "↩ Vrátiť" na `unavailable`/`discontinued` nikdy nemaže
  `product_supplier_link_override`. Opätovné rozdelenie ukáže predtým
  uložené hodnoty, integračný test (`pairing-review-variant-links-http
  .integration.test.ts`) dokazuje explicitne.
- **E2E fixtúra "E2E-PR-SPLIT" (2 varianty S/M) je JEDINÝ viacveľkostný
  produkt v `scripts/e2e-fixtures-pairing-review.ts`** — `seedProdukt`
  helper vytvára VŽDY presne jeden variant (`code === productKey`), takže
  split test potreboval VLASTNÉ (nie helperom vyrobené) vloženie
  `products`/`variants` s dvomi riadkami. Posunulo `catalog.spec.ts`'s
  pevné počty o +2 (total 107→109, "sellable" 77→79) — zdokumentované
  priamo tam (`.claude/rules/testing.md`'s "nový variant posunie počty" past).
- **E2E testy zdieľajúce TEN ISTÝ fixtúrový produkt v jednom spec súbore
  potrebujú VEDOMÉ PORADIE, nielen izolovaný účet.** `scripts/
  e2e-setup.ts` sa seeduje LEN RAZ pri štarte `webServer`u (nie pred
  KAŽDÝM testom) — `pairing-review-split.spec.ts`'s dva split testy oba
  mutujú "E2E-PR-SPLIT"'s `decision`, takže test bežiaci DRUHÝ vidí stav,
  aký zanechal PRVÝ. Riešenie: test, čo KONČÍ s `decision === null`
  (revert), musí bežať PRED testom, čo očakáva split TRIGGER tlačidlo
  (zobrazí sa len keď `decision === null`) — poradie v súbore = poradie
  behu. Druhý test navyše explicitne PREPÍŠE obe veľkosti vlastnými
  hodnotami, nezávisle od toho, čo prvý test zanechal v `pairing_variant_link`.
- **`window.confirm()` (missing-link varovanie pri "✓ Hotovo") potrebuje
  `page.on("dialog", d => void d.accept())` v e2e teste — Playwright BEZ
  registrovaného handlera dialóg AUTOMATICKY ZAMIETNE**, takže test bez
  neho by tichoTIMEOUTol/nezapísal rozhodnutie namiesto skutočného
  overenia "potvrdenie prejde ďalej".
- **Bare `getByRole("button", {name: "Hľadať"})` na obrazovke "Párovanie"
  koliduje s DVOMA inými prvkami naraz** (`.claude/rules/testing.md`'s
  zdokumentovaná trieda) — sidebarov "Vyhľadať" nav tab (case-insensitive
  substring "hľadať" ⊂ "vyhľadať") AJ VLASTNÁ "Hľadať / opraviť" pod-
  záložka (prefix). `{ name: "Hľadať", exact: true }` je jediná
  jednoznačná cesta k skutočnému submit tlačidlu.
- **Súhrnné "Hotovo"/potvrdzovacie tlačidlo NAD viacerými NEZÁVISLE
  ukladajúcimi sa RIADKAMI (každý riadok VLASTný `rowBusy` `useState`)
  potrebuje tento stav VYZDVIHNUTÝ do rodiča — nestačí len rodičov
  spoločný `busy` prop.** Nájdené v self-review (nie testom):
  `PairingReviewSplitPanel.tsx`'s "✓ Hotovo – rozdelené" kontrolovalo len
  `busy` (karta-úrovňová) a `variants === null`, nie `rowBusy` VNÚTRI
  `VariantRow`u (súkromný, rodičovi neviditeľný stav) — klik počas
  rozbehnutého zápisu JEDNÉHO riadku mohol vidieť ešte-nezapísaný
  (starý) stav a zbytočne ukázať konzervatívny potvrdzovací dialóg. Fix:
  rodič drží `Set<string>` kódov s bežiacim zápisom (`busyRowCodes`), dieťa
  (`VariantRow`) hlási zmenu cez `onBusyChange(code, busy)` callback pri
  `setRowBusy` (oba smery — `true` aj `false`, symetricky), rodičovo
  tlačidlo pridá `anyRowBusy = busyRowCodes.size > 0` do svojej `disabled`
  podmienky. Iný tvar ako existujúci "per-item vs. group busy-guard,
  disabled v OBOCH smeroch" vzor (`.claude/rules/frontend-design.md`,
  issue 60) — TAM sú dva SÚRODENECKÉ akcie (jedna na riadku, jedna nad
  skupinou), TU je to N nezávislých DETÍ hlásiacich svoj stav JEDNÉMU
  rodičovmu tlačidlu — pri KAŽDOM ĎALŠOM "spoločné Hotovo/Uložiť nad
  zoznamom nezávisle sa ukladajúcich riadkov" v tejto appke over, či
  riadky majú VLASTNÝ busy stav, ktorý treba vyzdvihnúť rovnakým
  callback vzorom.

## issue 422 — AI zdôvodnenie zhody + živé ceny/dostupnosť (audit úplnosti vs stará appka)

- **`chosenReason` je v TEJTO appke ŠTRUKTURÁLNE VŽDY `null` pre nenapárované
  produkty — na rozdiel od starej appky, kde `ai_reason` niesol dôvod aj pre
  "nenašla sa istá zhoda".** `run.ts`'s `buildChosenReason()` vracia `null`
  vždy, keď `pick.candidate === null`; `pickBest()` (`ranking.ts`) je
  "auto-fill" — vráti `candidate: null` (teda `chosenCandidate === null`)
  LEN keď je zoznam kandidátov PRÁZDNY, inak VŽDY vyberie najlepšieho
  nájdeného (aj slabého). Teda "žiadny kandidát" v tejto appke VŽDY znamená
  "gather nenašiel u dodávateľa nič" — presne to, čo existujúca "Nenašiel sa
  žiadny kandidát" hláška (E5/#401) už hovorí. `chosenReason` sa preto
  renderuje LEN vedľa `chosenCandidate !== null` (`ChosenCandidateExtras`,
  `PairingReviewPanelParts.tsx`) — pri ĎALŠOM porte podobného "dôvod aj pre
  negatívny prípad" poľa zo starej appky over najprv, či cieľové pole v TEJTO
  appke skutočne nesie hodnotu aj v negatívnom stave, nikdy nepredpokladaj
  paritu len z podobnosti mena poľa.
- **Živá cena/dostupnosť dodávateľa potrebuje TROJICU RÔZNYCH extrakcií, nie
  jeden zdieľaný regex — živo overené 13. 8. 2026 (curl cez session
  warm-up, reálne produktové stránky z E2 search-fixtúr).** WETLAND
  (wetland.sk) aj ODIMON (odimon.sk) nesú platné JSON-LD `Offer`
  (`price`/`availability`) — zdieľaný helper `adapters/detail-meta.ts`'s
  `jsonLdSupplierDetailMeta`, znovupoužíva `supplier-stock/parse.ts`'s už
  otestovanú `fromJsonLd` (DRY, spoľahlivejšie než vlastný regex bez
  ohľadu na poradie `property=`/`content=` atribútov). **BETALOV
  (huntingshop.eu) NEMÁ žiadne JSON-LD ani `og:price`/`og:availability`
  meta značky vôbec** — naivný CSS-triedový výber (`.actual-price`/
  `.badge-stock`) je NEBEZPEČNÝ, tie isté triedy sa na stránke opakujú
  4-6× v karuseli súvisiacich produktov (presne tá istá "karuselová
  kolízia" trieda chýb ako issue 223, `.claude/rules/supplier-stock.md`).
  Skutočný spoľahlivý zdroj: `var prodData = {"price":36.5,
  "is_item_in_stock":1,...};` JS premenná (GA dataLayer prípravok),
  JEDINÝ výskyt na stránke, priamo pri hlavnom produkte — vlastná
  extrakcia `parseBetalovDetailMeta` v `betalov.ts` (regex na `var
  prodData = ({[^}]*});`, `JSON.parse` s try/catch). Test pri KAŽDOM
  ĎALŠOM podobnom "extrahuj X z detailnej stránky dodávateľa": over živo
  KAŽDÉHO z troch dodávateľov osobitne, nikdy nepredpokladaj, že jeden
  mechanizmus pokryje všetkých — presne tento ticket dokázal, že dvaja
  majú JSON-LD a jeden potrebuje úplne iný zdroj.
- **ODIMON's JSON-LD vie KLAMAŤ o dostupnosti (issue 225, `.claude/rules/
  supplier-stock.md`) — akceptované riziko PRE TENTO ticket, lebo ide o
  čisto INFORMATÍVNY náhľad pre reviewera (link je viditeľný vedľa), nie o
  automatické prepínanie ako `restock`.** Pri rozšírení tohto live-info
  mechanizmu na ĎALŠIE, automatizované rozhodovanie (napr. auto-schválenie
  kandidáta na základe dostupnosti) by bolo treba to isté krížové overenie
  proti viditeľnému textu, aké `restock`'s `parsePage()` už robí — never
  preniesť "akceptované pre informatívny náhľad" riziko do automatizácie
  bez opätovného zváženia.
- **Live-info endpoint dispatchuje VÝHRADNE cez `adapterForUrl` (host-based
  lookup, `registry.ts`) — URL mimo troch známych adaptérov degraduje TICHO
  na `{price:null, availabilityText:null}`, BEZ akéhokoľvek sieťového
  volania.** Zámerné zúženie rozsahu (design komentár na tickete): candidate/
  `chosenCandidate` URL sú VŽDY adaptérového pôvodu (gather beží len cez tieto
  tri adaptéry) — jediný degradovaný prípad je zriedkavá plne ručne zadaná
  linka od neznámeho dodávateľa (`decision.url` pri `status: "manual"`), čo
  sa v tejto appke NIKDY nezobrazuje ako živé info (na rozdiel od starej
  appky, čo aj manuálnu URL live-fetchovala) — vedomá, dokumentovaná
  odchýlka od 1:1 portu, nie medzera.
- **`registerPairingReviewRoutes`'s nový `searchClient?: SearchClient`
  parameter (default `new SearchClient()`) je rovnaká DI disciplína ako
  `fetchSupplierPage`/`restock`'s config v `http/app.ts`** — testy
  (integračné aj e2e) NIKDY nechodia na skutočnú sieť: integračné testy
  injektujú vlastný `Fetcher` cez `createApp(db, {pairingSearchClient: new
  SearchClient({fetcher})})`; e2e fixtúry (`e2e-fixtures-pairing-review.ts`)
  majú VŠETKY candidate URL na `e2e-dodavatel.example.com` (mimo troch
  známych adaptérov) — to isté zúženie rozsahu vyššie preto e2e beh
  automaticky drží mimo skutočnej siete, bez potreby vlastného mock servera.
- **`var prodData` regex fixtúra (`fixtures/betalov-detail-cena-
  dostupnost.html`) MUSÍ zostať PLOCHÝ JS objekt (žiadne vnorené `{}`)** —
  `PRODATA_RE`'s `[^}]*` capture group (jednoduchšie a bezpečnejšie než
  `[\s\S]*?` pri drift-e markupu) sa zastaví na PRVEJ `}`, takže reálny
  vnorený objekt v `prodData` by extrakciu odrezal uprostred. Živo overené
  (2 reálne huntingshop.eu produkty): `prodData` je VŽDY plochý (žiadne
  vnorené polia/objekty), takže tento zjednodušený regex je bezpečný pre
  REÁLNY tvar, nie len pre testovaciu fixtúru — pri budúcej zmene markupu
  over znova `curl`om, či `prodData` ostáva plochý, predtým než sa regex
  "vylepší" na `[\s\S]*?`.
- **"Naša strana" agregácia (`standardPriceMin/Max`/`stockTotal`/
  `availabilityText`, `pairing-review/queries.ts`) kopíruje presne ten istý
  vzor ako existujúce `priceMin/Max` — min/max cez `Number`/`toFixed(2)`,
  distinct-join pre text.** `stockTotal` je SÚČET (nie min/max) naprieč
  variantmi — zásoba je v tomto obchode dekoratívna (`.claude/rules/
  catalog.md`'s "stock NEVSTUPUJE do odvodenia stavu"), ale súčet je stále
  najzmysluplnejšia agregácia na zobrazenie (koľko kusov spolu, nie rozsah).
  `availabilityText` sú DISTINCT neprázdne texty naprieč variantmi spojené
  " / " — pri ~2700 jednovariantných produktoch (playbook, E5 sekcia) je
  toto v praxi takmer vždy jeden text, viacnásobný join je len pre
  viacveľkostné produkty s odlišnou dostupnosťou per veľkosť.
- **Per-URL/per-kľúč in-memory cache BEZ TTL je v tejto appke tichá staleness
  chyba, nie len teoretická obava — appka beží ako DLHOŽIVÝ kontajner (dni,
  nie jeden request).** Self-review nález (🟡) na `live-detail-info.ts`'s
  pôvodnú implementáciu: cache bez TTL by "živé" info navždy zamrazila na
  PRVEJ hodnote — vrátane PRVÉHO ZLYHANIA (transientný sieťový výpadok by
  produkt navždy nechal bez live infa, kým appka nereštartuje). Fix:
  `CACHE_TTL_MS = 15 min` na úspech AJ zlyhanie (injektovateľné `now()` pre
  testy), ale URL MIMO známych adaptérov (štrukturálny fakt o URL, nikdy sa
  nemení) sa cachuje BEZ TTL — nie každá cache v tejto appke potrebuje TTL,
  len tá, čo drží HODNOTU, ktorá sa v čase reálne mení. Test pri KAŽDEJ
  ĎALŠEJ novej module-level/factory-scoped cache v tomto repe (nielen
  live-fetch): drží HODNOTU, čo sa môže zmeniť (cena, dostupnosť, externý
  stav), alebo len ŠTRUKTÚRU (dispatch rozhodnutie, statický fakt)? Prvé
  potrebuje TTL, druhé nie — a nikdy sa nespoliehaj na to, že "cache
  re-renders don't re-fetch" zámer implicitne znamená "navždy".
- **`variant_money_needs_currency_ck` CHECK constraint (`.claude/rules/
  database.md`) zachytí KAŽDÝ nový test/fixtúru, čo nastaví `price`/
  `standardPrice` bez `currency`** — oba seed helpery
  (`tests/helpers/pairing-review.ts`, `scripts/e2e-fixtures-pairing-
  review.ts`) museli dostať `currency: "EUR"` VŽDY, keď je nastavená
  hociktorá cena (predtým currency vôbec nesetovali, lebo žiadny existujúci
  test/fixtúra predtým price nepoužívala/nepoužívala ho SAMOSTATNE od
  currency). Test pri KAŽDOM ĎALŠOM seed helperi, čo dostane nové
  peňažné pole: over CHECK constraint PRIAMO na throwaway Postgrese pred
  spoliehaním sa na to, že `?? null` default v inserte stačí.

## issue 432 — DVE RÔZNE metriky na obrazovke Párovanie: veľkosť FRONTY vs. katalógové POKRYTIE

- **`gatheredTotal`/`linkedTotal` (`listPairingReview`, `pairing-review/
  queries.ts`) merajú VEĽKOSŤ RECENZNEJ FRONTY, NIE pokrytie katalógu
  linkami — nikdy ich nezameň za "koľko produktov má odkaz".** Populácia
  fronty je ÚNIA (`determineReviewPopulationKeys`): gatherované ∪ produkty
  BEZ efektívnej linky ∪ rozhodnuté. Je teda Z DEFINÍCIE zložená hlavne z
  produktov BEZ linky, takže `linkedTotal / gatheredTotal` vychádza extrémne
  nízko (na prod ~2/2303) — vyzerá to ako "linky zmizli", hoci dáta sú v
  poriadku. Presne toto majiteľ nahlásil ako #432; koreň bol commit 3779235
  (#398/#401), ktorý populáciu rozšíril z "gatherované" na túto úniu, ale
  frontend text „N / M s odkazom" ostal.
- **Skutočné katalógové pokrytie = `computeCatalogCoverage(db)`
  (`catalogActive`/`catalogLinked`).** `catalogActive` = produkty s aspoň
  jedným PREDAJNÝM variantom (`variant.state === "sellable"`,
  `db.selectDistinct` — tá istá definícia "sellable" ako `rollupProductState`
  v tom istom súbore); `catalogLinked` = z NICH tie s efektívnou linkou
  (`resolveEffectiveSupplierLink` = override ∪ `internalNote` extrakcia,
  žiadny duplicitný regex). Počíta sa NEZÁVISLE od populácie fronty (aj keď
  je fronta prázdna — napr. všetko olinkované — pokrytie ostáva správne;
  aktívny olinkovaný produkt MIMO fronty sa v pokrytí objaví, hoci
  `linkedTotal` ho minie). Menovateľ ZÁMERNE NIE JE celý katalóg (4547) —
  ~2000 dávno ukončených produktov linku nikdy nemalo, stláčali by číslo na
  ~49 % a vyzeralo by to zase ako strata; prod má vyjsť ~2081/2528.
- **Frontend (`PairingReviewSection.tsx`): hlavný ukazovateľ + progress bar
  = `catalogLinked`/`catalogActive`; `gatheredTotal` (veľkosť fronty) je len
  samostatný menší riadok „vo fronte na revíziu: N"** (`data-testid=
  "pairing-review-progress-queue"`). `linkedTotal` sa už nezobrazuje ako
  hlavné číslo (state odstránený). Progres text sa smie ZALOMIŤ (žiadny
  `white-space: nowrap` — dlhší popis by na `wide: true` obrazovke pretiekol,
  issue 291/382); progress bar má `min-width` + `flex-wrap` na rodičovi, aby
  sa na úzkej šírke zalomil pod text.
- **Pri KAŽDOM ĎALŠOM "toto číslo mi nesedí" hlásení o počítadle na tejto
  obrazovke:** najprv over, ČI daná metrika meria FRONTU (populácia úniou)
  alebo KATALÓG (pokrytie) — sú to dve rôzne množiny a ľahko sa zamenia v
  texte UI. Test na logiku (nie presné čísla) je
  `pairing-review-catalog-coverage-http.integration.test.ts` (override link
  počíta sa · internal_note URL počíta sa · bez linky len menovateľ · bez
  sellable variantu ani v menovateli · aktívny olinkovaný MIMO fronty sa
  ráta).
