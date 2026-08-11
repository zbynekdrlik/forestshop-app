---
paths:
  - "apps/api/src/modules/restock-links/**"
  - "apps/api/src/http/restock-links-routes.ts"
  - "apps/api/tests/restock-links-http.integration.test.ts"
  - "apps/web/src/restockLinksApi.ts"
  - "apps/web/src/components/RestockLinkSuggestionsSection.tsx"
  - "scripts/e2e-fixtures-restock-links.ts"
---

# Vypredané → Skladom: návrhy odkazov (issue 311)

- **Populácia je presne "restock kandidát bez linky", nie "produkt bez
  linky" vo všeobecnosti.** Diagnostika #307: automatika "Vypredané →
  Skladom" (`restock/queries.ts`'s `allRestockCandidates`) nikdy neposúdi
  produkt, ktorého efektívna linka je `null` — 91 zo 130 vypredaných
  produktov také bolo. Táto obrazovka preto berie PRESNE tú istú populáciu
  ako `allRestockCandidates` (`variant.state = 'out_of_stock'` +
  `product_visibility = 'visible'` + `missing_since IS NULL`), len BEZ
  podmienok o potvrdení dodávateľa (tie sem nepatria — produkt bez linky
  nemá čo potvrdiť) A s efektívnou linkou `null`. **Zámerne odlišná od**
  "Párovanie produktov" (#239, `product-links/queries.ts`'s
  `listProductLinks`), ktorá vypisuje VŠETKY produkty katalógu bez linky,
  bez ohľadu na to, či sú vypredané — dve rôzne, prekrývajúce sa množiny.
- **Kandidát sa hľadá DETERMINISTICKY (nikdy AI), porovnaním významných slov
  názvu (3+ znaky, diakritika normalizovaná) medzi produktom bez linky a
  produktmi, čo UŽ linku majú** — `suggestCandidates`
  (`restock-links/queries.ts`). Zhodný `product.supplier` pridáva veľký
  bonus (100), aby VŽDY vyhral nad čisto textovou zhodou naprieč cudzími
  dodávateľmi. Toto JE "vyhľadanie podľa názvu cez existujúci mechanizmus",
  ktorý ticket žiadal — rovnaký princíp ako `search/queries.ts`'s
  `globalSearch`, len nad VLASTNÝM katalógom (appka nemá a NEBUDE mať
  nástroj na vyhľadávanie na internete). Kandidáti sa počítajú ŽIVO pri
  KAŽDOM načítaní (rovnaký princíp ako `feed-cross-check.ts` — nikdy
  perzistovaná odvodená hodnota, tá by zastarala pri ďalšom katalógovom
  importe).
- **Návrh sa NIKDY neuloží sám — klik na kandidáta len PREDVYPLNÍ vstup.**
  `RestockLinkSuggestionsSection.tsx`'s "💡 Použiť" tlačidlo nastaví
  `urlDraft`, skutočné uloženie ide AŽ cez explicitný klik na 💾 (rovnaká
  podmienka ako ticket žiadal: "ČLOVEK potvrdí, nikdy automaticky
  nepriradiť"). Regresný e2e dôkaz (`restock-links.spec.ts`) klikne na
  návrh a OVERÍ, že `saveProductLink` sa ešte NEZAVOLALO, až potom klikne
  Uložiť.
- **Žiadna nová zapisovacia trasa ani nová tabuľka.** Potvrdený odkaz ide
  cez UŽ EXISTUJÚCU `POST /api/product-links/:productKey` (#239,
  `setProductSupplierLinkForProduct`, `product_supplier_link_override`) —
  `restockLinksApi.ts` má len ČÍTACIU `searchRestockLinkSuggestions`,
  komponent priamo importuje `saveProductLink` z `supplierLinksApi.ts`.
  Dôsledok: obe obrazovky ("Vypredané → Skladom: návrhy odkazov" aj
  "Párovanie produktov") ukazujú TÚ ISTÚ hodnotu okamžite po uložení —
  overené e2e testom naprieč OBOMA obrazovkami naraz.
- **Nová obrazovka je SAMOSTATNÁ od "Vypredané → Skladom" (#213,
  `RestockSection.tsx`), nie ďalšia karta v nej** — `RestockSection.tsx` je
  už na 370 riadkoch (eslint `max-lines: 400`, `.claude/rules/testing.md`)
  a rieši úplne iný problém (PREPÍNANIE už-linkovaných produktov). Zdieľajú
  len susedné miesto v menu (`nav.ts`, priečinok Automatizácie, hneď za
  sebou) a rovnaký cieľ (viac kandidátov pre prepínanie).
- **E2E fixtúra (`scripts/e2e-fixtures-restock-links.ts`) potrebuje TRI
  produkty naraz na jeden zmysluplný test:** vypredaný bez linky
  ("E2E-RL-CHYBA"), kandidát s ROVNAKÝM dodávateľom + prekrývajúcim sa
  menom, čo UŽ linku má ("E2E-RL-NAVRH"), a CUDZÍ dodávateľ bez prekryvu
  mena ("E2E-RL-CUDZI") — dokazuje, že sa nikdy nenavrhne bez zhody. Vlastný
  izolovaný e2e účet (`E2E_NAVRHY_ODKAZOV_EMAIL`, rovnaký mechanizmus a
  dôvod ako `E2E_PAROVANIE_EMAIL` — zdieľaný `e2e@forestshop.sk` je na
  hranici `MAX_ATTEMPTS`).
- **Nová viditeľná záložka "Vypredané → Skladom: návrhy odkazov" substring-om
  KOLIDOVALA s existujúcim `restock-waiting.spec.ts`'s
  `getByRole("button", {name: "Vypredané → Skladom"})`** (rovnaká trieda
  chyby ako issue 240's "Vyhľadať"/"Hľadať" kolízia, `.claude/rules/
  testing.md`) — opravené na strane KOLÍDUJÚCEHO existujúceho locatora
  (`{ exact: true }`), nikdy premenovaním novej záložky. Test pri KAŽDEJ
  ďalšej záložke pridanej HNEĎ VEDĽA existujúcej s podobným menom: `grep -rn
  'name: "<časť existujúceho mena>"' apps/web/tests/e2e/` bez `exact: true`.
- **Naživo overiť "návrh → potvrdiť" na produkcii bez ponechania testovacích
  dát: over `synced_at IS NULL` PRED zmazaním, potvrď skutočný kandidát,
  potom RIADOK ZMAŽ (nie prepíš na prázdno — `supplierLinkUrlBody` vyžaduje
  platnú URL, prázdny reťazec sa uložiť nedá).** Post-deploy overenie issue
  311 (7. 8. 2026): klik na skutočný (appkou navrhnutý) kandidát pre
  "Batéria OLIGHT 18650 nabíjateľná 2600 mAh 3,7V" (ODIMON) → uložené →
  `Nájdených: 35→34` → potvrdené aj na "Párovanie produktov" (rovnaký
  zápis). `product_supplier_link_override.synced_at` bol `NULL`
  (`shoptet-writeback` job odkaz ešte neposlal — beží nočne/na ručný
  spustenie, nie hneď po uložení) → bezpečné `DELETE FROM
  product_supplier_link_override WHERE product_key = '...' AND synced_at IS
  NULL` priamo cez `docker compose exec postgres psql` na dev2 (rovnaký
  prístup ako `.claude/rules/product-links.md`'s "shoptet-writeback" časť) —
  vrátilo produkt do pôvodného stavu (`Nájdených: 35`) bez toho, aby
  vymyslená/testovacia hodnota niekedy dorazila do reálneho Shoptetu. Test
  na KAŽDÉ ĎALŠIE naživo overenie "pridaj odkaz" flow na produkte, čo dovtedy
  ŽIADEN odkaz nemal: `synced_at IS NULL` je podmienka bezpečného zmazania,
  NIE predpoklad — over ju dopytom PRED zmazaním, nikdy nepredpokladaj.
- **Issue 331: prečo #311 nezdvihlo pokrytie ODKAZOV, hoci mechanizmus návrhov
  funguje bezchybne — chýbala VIDITEĽNOSŤ a RÝCHLOSŤ, nie logika.** Živé
  overenie: všetkých vtedy chýbajúcich produktov malo aspoň jedného
  navrhnutého kandidáta (`with_candidates` = 100 %), ale
  `product_supplier_link_override` nezaznamenala ANI JEDNO nové potvrdenie
  medzi nasadením #311 a nálezom #331 — obrazovka SAMA ukazovala "Nájdených:
  N", ale toto číslo bolo vidno LEN po vyslovnom otvorení tejto jednej
  obrazovky, nikde inak v appke. Fix: **odznak v ľavom menu** (`App.tsx`'s
  `restockLinksMissingCount`, presne rovnaký vzor ako `upozorneniaCount`/
  issue 267 — `fetchRestockLinksMissingCount`, `restockLinksApi.ts`, číta
  TEN ISTÝ `GET /api/restock-links` s `pageSize=1`, keďže `total` sa počíta
  nad CELOU odfiltrovanou množinou nezávisle od `pageSize`) plus
  **jednoklikové potvrdenie**: predošlý dvojklikový "💡 Použiť → predvyplní
  vstup → 💾 Uložiť" sa zmenil na "✅ Potvrdiť" (jeden klik, meno aj URL
  kandidáta viditeľné na tlačidle PRED kliknutím — stále výslovné ľudské
  potvrdenie na KONKRÉTNOM návrhu, nikdy auto-priradenie). "✏️ Doplniť"
  (ručný/opravný vstup, top kandidát predvyplnený) ostáva bezo zmeny pre
  korekciu. Zamietnutá alternatíva: karta na nástenke "Upozornenia" — tá
  tabuľka je postavená na PER-UDALOSŤ dedup/resolve sémantike (konkrétna
  zásielka/vrátenie), nie na živý agregovaný počet inej obrazovky; 30+
  samostatných kariet by zaplavilo nástenku, ktorú majiteľ výslovne žiadal
  držať krátku (#303/#327). Test pri KAŽDOM ĎALŠOM "prečo sa X nepoužíva,
  hoci appka to vie" tickete: over NAJPRV, či je populácia/logika naozaj
  chybná (živý dopyt), než sa hľadá UI príčina — tu bola logika v poriadku,
  problém bol čisto vo VIDITEĽNOSTI a POČTE KLIKOV.
- **Overenie produkčných čísel PRED písaním kódu (živý dopyt cez appkinu
  VLASTNÚ, už skompilovanú logiku, nie ručne prepísaný SQL ekvivalent)**:
  `docker exec forestshop-app-1 sh -c 'cd /app/apps/api && node -e "const {
  createDb } = require(\"./dist/db/client.js\"); const { <funkcia> } =
  require(\"./dist/modules/<modul>/queries.js\"); const { db } =
  createDb(process.env.DATABASE_URL); <funkcia>(db, {...}).then(r =>
  console.log(JSON.stringify(r)));"'` — `createDb()` vracia `{ pool, db }`,
  nie priamo `db` (bežná chyba: `db.select is not a function` pri
  zabudnutí `.db`). Toto beží PRIAMO appkinu skutočnú `suggestCandidates`/
  `listRestockLinkSuggestions` logiku (žiadne riziko, že ručne napísaný SQL
  ekvivalent nesedí s tým, čo appka reálne robí) — použité pri issue 331 na
  overenie "majú VŠETKY chýbajúce produkty kandidáta?" bez písania
  jediného riadku appkového kódu vopred. Rovnaký vzor pre KAŽDÉ ĎALŠIE
  "over živé číslo/správanie appkinej logiky na produkcii" pred diagnózou.
