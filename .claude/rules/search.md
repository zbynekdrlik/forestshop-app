---
paths:
  - "apps/api/src/modules/search/**"
  - "apps/api/src/modules/product-detail/**"
  - "apps/api/src/http/search-routes.ts"
  - "apps/api/src/http/product-detail-routes.ts"
  - "apps/web/src/searchApi.ts"
  - "apps/web/src/components/SearchSection.tsx"
  - "apps/web/src/components/OrderSearchPanel.tsx"
---

# Eshop → Vyhľadať (issue 240, issue 289)

- **OPRAVA nedorozumenia z issue 240 (zapísané na ticket 289, overené
  priamo v kóde pred zmenou): "dve oddelené polia" popisovalo len BACKENDOVÝ
  dátový model (`GlobalSearchResult.products`/`.orders`, dve polia v JEDNEJ
  JSON odpovedi), NIE dve oddelené VSTUPNÉ polia vo formulári — do issue 289
  malo `SearchSection.tsx` JEDNO spoločné textové pole ("Hľadať"), ktoré
  hľadalo naraz produkty aj objednávky cez `GET /api/search?q=...`, a
  frontend výsledok len rozdeľoval do dvoch VIZUÁLNYCH blokov pod tým istým
  poľom. Issue 289 (majiteľova požiadavka) toto zmenilo na SKUTOČNE dve
  nezávislé vstupné polia — "Produkt" (`SearchSection.tsx`) a "Objednávka"
  (`OrderSearchPanel.tsx`, vlastný súbor/stav) — každé s vlastným dopytom,
  vlastným tlačidlom, vlastným výsledkom. Backend sa NEZMENIL: obe polia
  volajú TÚ ISTÚ `GET /api/search?q=...` cestu (vždy vracia oba zoznamy
  naraz), každé si z odpovede vezme len svoju polovicu — žiadna nová
  backendová cesta nebola potrebná ani pridaná. Klik na nájdenú objednávku
  vedie do Shoptet detailu objednávky (`o.adminUrl`, postavené
  `buildShoptetAdminOrderUrl`-om — TEN ISTÝ helper ako
  `OrderReminderRow.tsx`/`MailLogSection.tsx`/Upozornenia), rozhodnuté na
  ticket-e; appka ho tu len znovupoužíva, nebolo treba nič meniť.
- **`OrderSearchPanel` je namontovaný VŽDY, aj počas zobrazenia detailu
  produktu — mimo `SearchSection.tsx`'s `if (selectedProductKey !== null)`
  vetvy, nie vo vnútri nej.** Dôvod: pôvodné jedno spoločné pole (issue
  240) malo svoj `result` stav v TOM ISTOM komponente ako detail produktu,
  takže prechod do detailu a späť ho nikdy neodmountoval — objednávkový
  výsledok prežil. Keby bol `OrderSearchPanel` vykreslený LEN vo vetve so
  zoznamom (nie aj vo vetve s detailom), React by ho pri otvorení detailu
  produktu odmountoval a jeho dopyt/výsledok by sa stratil — regresia oproti
  pôvodnému správaniu. Obe vetvy `SearchSection.tsx`'s návratu preto končia
  `<OrderSearchPanel onSessionExpired={onSessionExpired} />` ako posledným
  súrodencom (Fragment), nikdy len jedna z nich.
- **Tlačidlá polí sú POMENOVANÉ ODLIŠNE ("Hľadať produkt"/"Hľadať
  objednávku"), nie obe len "Hľadať"** — dva rovnaké prístupné mená v
  jednom formulári by si navzájom kolidovali (Playwright aj Testing
  Library `getByRole("button", {name})` by vrátili 2 prvky) a `.claude/
  rules/testing.md` už dokumentuje, že bare "Hľadať" koliduje aj s
  `catalog.spec.ts`'s vlastným "Hľadať" tlačidlom substring-om cez
  "Vyhľadať" nav záložku — odlišné mená obe riziká odstraňujú, nie len to
  jedno. Rovnako `<label>`y sú "Produkt"/"Objednávka" (nie "Hľadať X") —
  krátke, ľudské popisky nad/pri poli, presne ako ticket žiadal.
- **"Hľadať prednostne produkty, potom objednávky" (pôvodná formulácia
  240) je teraz len historický kontext** — s dvoma nezávislými poľami
  (289) sa "poradie produktov pred objednávkami" netýka poradia
  VYHĽADÁVANIA (obe polia sú si rovné, žiadne "prednostne"), len poradia,
  v akom sú polia/výsledky vykreslené na obrazovke (Produkt hore,
  Objednávka dole — ticket 289's doslovná požiadavka). Rozšírenie o ĎALŠIU
  prehľadávanú oblasť (napr. dodávateľov) patrí ako TRETIE, rovnako
  nezávislé pole, nie zamiešané do jedného z existujúcich dvoch.
- **Editácia dodávateľskej linky na tejto obrazovke ide VÝHRADNE cez
  existujúcu `POST /api/product-links/:productKey` (issue 239) —
  `product-detail` trasa je LEN NA ČÍTANIE.** Nepridávaj sem druhú
  zapisovaciu cestu do `product_supplier_link_override` — `saveProductLink`
  (`supplierLinksApi.ts`) sa importuje a používa priamo z `SearchSection.tsx`.
- **Dostupnosť u dodávateľa (`supplier_stock`) sa páruje VÝHRADNE podľa
  linky extrahovanej z `product.internalNote` (`extractSupplierLink`),
  NIKDY podľa manažérovho override.** Toto NIE JE bug ani nekonzistencia —
  je to TEN ISTÝ zdroj, aký používa scraper (`supplier-stock/run.ts`'s
  `collectSupplierLinks`) aj `restock/queries.ts` všade inde v appke.
  Scraper override nesleduje vôbec (mimo rozsahu #240) — `getProductDetail`
  (`product-detail/queries.ts`) preto číta `supplierStock` podľa
  `scrapedLink` (z `internalNote`), zatiaľ čo zobrazená EFEKTÍVNA linka
  (`supplierLinkUrl`) uprednostňuje override — dve rôzne premenné v tej istej
  funkcii, zámerne.
- **Nová viditeľná záložka v `nav.ts` (Sidebar je vždy namountovaný) môže
  substring-om kolidovať s existujúcimi `getByRole("button", {...})`
  dopytmi naprieč CELÝM e2e balíkom** — `.claude/rules/testing.md` má plný
  detail a postup (issue 240: "Vyhľadať" vs. existujúce "Hľadať" tlačidlá v
  `catalog.spec.ts`).
