---
paths:
  - "apps/api/src/modules/pairing-search/**"
---

# Profesionálne párovanie produktov — jadro vyhľadávania (issue 387)

Port starej appky (`https://github.com/zbynekdrlik/parovanie-produktov`,
commit `60b6164`) do tejto appky, po etapách (E1..E9 — návrh
https://github.com/zbynekdrlik/forestshop-app/issues/387#issuecomment-5273377438).
**Tento súbor NAHRADÍ `.claude/rules/restock-links.md`, keď E8 vyradí #311**
(návrh, sekcia 4) — dovtedy existujú vedľa seba.

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
