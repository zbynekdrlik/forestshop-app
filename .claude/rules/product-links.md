---
paths:
  - "apps/api/src/modules/product-links/**"
  - "apps/api/src/http/product-links-routes.ts"
  - "apps/api/tests/product-links-http.integration.test.ts"
  - "apps/web/src/supplierLinksApi.ts"
  - "apps/web/src/components/SearchSection.tsx"
---

# Zápisová cesta `product_supplier_link_override` (pôvodne issue 239)

**Obrazovka "Párovanie produktov" (issue 239) bola ODSTRÁNENÁ issue 400
(2026-08-13, issue 387 E9) — majiteľ ju výslovne schválil ("a stare
parovanie produktov z apky odober"), po tom, čo ju nahradila nová obrazovka
"Párovanie" (issue 387 E5+, `.claude/rules/pairing-search.md`).** Odstránené
bolo VÝHRADNE UI: `SupplierLinksSection.tsx`, jej dva testové súbory, jej
e2e (`supplier-links.spec.ts`), jej nav položka (`supplier-links`) a časti
`supplierLinksApi.ts` používané VÝHRADNE ňou (`searchProductLinks`,
`ProductLinkState`, `ProductLinkItem`, `PAGE_SIZE`). **Backend (`GET`/`POST
/api/product-links(...)`, `apps/api/src/modules/product-links/**`) a
zdieľané zápisové jadro NEBOLI odstránené vôbec** — dôkaz živým `git diff`
naprieč commitmi issue 400, presne ako issue 387 E8 dokumentuje pre svoj
vlastný precedens (`.claude/rules/pairing-search.md`, sekcia E8, posledný
bod).

**Dnešní volajúci zdieľaného zápisu (obaja MIMO tejto obrazovky, MUSIA
ostať funkční pri akejkoľvek ďalšej zmene tu):**
- `apps/web/src/components/SearchSection.tsx` ("Eshop → Vyhľadať", #240) —
  cez `POST /api/product-links/:productKey`
  (`supplierLinksApi.ts`'s `saveProductLink`, ktorý v súbore OSTAL, lebo je
  zdieľaný — `.claude/rules/search.md`).
- `apps/api/src/modules/pairing-review/decisions.ts` ("Eshop → Párovanie",
  issue 387 E6) — priamo cez `upsertProductSupplierLink` (nie cez HTTP
  trasu), v JEDNEJ transakcii so zápisom `pairing_decision`.

- **Zámerne SAMOSTATNÁ od skrytej `pairing` záložky (F4), nie rozšírenie.**
  `pairing` (`.claude/rules/pairing.md`) je kľúčovaná `variant.code` a má
  vlastný `navrhnute → potvrdene` stavový automat pre BUDÚCE automatické
  hľadanie kandidátov u veľkoobchodného dodávateľa (#46/#48) — nezapisuje
  do Shoptetu vôbec. Táto zápisová cesta je kľúčovaná `product.key`
  (rovnako ako `product_supplier_link_override`, #121) a zapisuje VÝHRADNE
  do tej istej override tabuľky, ktorú existujúci `shoptet-writeback` job
  (#122) posiela do Shoptetu. Návrh na rozšírenie `pairing` o "chýbajúce
  linky" mód bol zámerne zamietnutý — zmiešalo by to dva nezávislé dátové
  modely do jednej tabuľky/obrazovky. F4 (obrazovka aj tabuľka `pairings`)
  čaká na samostatné rozhodnutie majiteľa (issue 400 sa jej netýka).
- **Zápisové jadro je zdieľané s #121's riadkovou cestou.**
  `supplier-link-assignment.ts`'s `upsertProductSupplierLink` (zúžený `tx`
  parameter `Pick<Database, "select" | "insert">`, presne podľa
  `.claude/rules/database.md`'s vzoru) je spoločné jadro pre
  `setProductSupplierLink` (cez `lineId`, dopočíta `productKey` cez JOIN
  na `orderLines`/`variants`) a `setProductSupplierLinkForProduct` (priamo
  cez `productKey`, keďže produkt bez otvorenej objednávky `lineId` nemá).
  Ďalšia zdieľaná zložka: `supplierLinkUrlBody` (zod schéma URL+http(s)+
  formula-guard) — `orders-routes.ts` ju teraz len re-exportuje ako
  `orderLineSupplierLinkBody`, nedupliuje.
- **Efektívna linka sa počíta v JS, nie v SQL** (`queries.ts`'s
  `listProductLinks`) — `resolveEffectiveSupplierLink` je čistá regexová
  funkcia nad `internalNote`, rovnaký vzor ako `supplier-stock/run.ts`'s
  `collectSupplierLinks`. Celý katalóg sa načíta a filtruje/stránkuje v
  pamäti (prijateľné pre manažérsku obrazovku, živo overené na 4542
  produktoch bez merateľného oneskorenia).
- **Naživo overiť "insert/correct" bez porušenia "adresa sa nikdy
  nedopĺňa odhadom" (ticketova bezpečnostná podmienka): NIKDY nevymýšľaj
  URL pre reálny produkt, ani na test.** Namiesto vloženia vymyslenej
  adresy do produktu, ktorý ju nemá, over "doplniť/opraviť" cestu na
  produkte, ktorý UŽ MÁ efektívnu linku (filter "S linkou") — klikni
  "Upraviť", nech sa predvyplní JEHO VLASTNÁ existujúca hodnota (zo
  Shoptet-ovho `internalNote`), a ulož TÚ ISTÚ hodnotu späť cez nový
  mechanizmus. Toto je skutočný, honestný dôkaz "insert path funguje" bez
  rizika, že AI zapíše zlú/vymyslenú business dátu do živého Shoptet
  poľa. Použité pri #239's post-deploy overení (produkt "01 Detské tričko
  - Jeleň ručiaci").
- **Manuálne spustenie `shoptet-writeback` jobu na produkcii** (na overenie,
  že novo uložený override reálne dorazí do Shoptetu, nie len do našej DB)
  ide identickým postupom ako `.claude/rules/shoptet-writeback.md`
  dokumentuje pre #122/#123: malý `.mjs` skript importujúci
  `./dist/db/client.js` + `./dist/modules/shoptet-writeback/run-writeback.js`
  + `./dist/modules/shoptet-writeback/config.js`, skopírovaný cez `docker cp`
  do `/app/apps/api/` VNÚTRI bežiaceho kontajnera (`docker exec -w
  /app/apps/api forestshop-app-1 node <skript>.mjs`), prihlasovacie údaje
  (`SHOPTET_ADMIN_USER`/`_PASSWORD`/`SHOPTET_ADMIN_BASE_URL`) číta priamo z
  kontajnerovho prostredia. Výsledok `{"status":"ok","productCount":N,
  "rowCount":M}` je PRIAMY dôkaz doručenia — `runShoptetWriteback` interne
  potvrdzuje úspech AŽ spätným čítaním Shoptet-ovho vlastného Logu importov,
  nikdy len "CSV sa odoslalo". Skript po overení zmazať (`docker exec -u
  root ... rm`, rovnaký dôvod ako #122/#123 — súbory z `docker cp` patria
  rootovi).
