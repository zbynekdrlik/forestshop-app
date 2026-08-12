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
