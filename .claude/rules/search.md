---
paths:
  - "apps/api/src/modules/search/**"
  - "apps/api/src/modules/product-detail/**"
  - "apps/api/src/http/search-routes.ts"
  - "apps/api/src/http/product-detail-routes.ts"
  - "apps/web/src/searchApi.ts"
  - "apps/web/src/components/SearchSection.tsx"
---

# Eshop → Vyhľadať (issue 240)

- **"Hľadať prednostne produkty, potom objednávky" sa rieši DVOMA
  ODDELENÝMI poľami (`GlobalSearchResult.products`/`.orders`), NIE jedným
  zoradeným zoznamom s relevance skóre.** Frontend ich vykreslí ako dva
  vizuálne oddelené bloky v tomto poradí — produkty prirodzene skončia PRED
  objednávkami bez toho, aby bolo treba počítať/porovnávať skóre naprieč
  dvomi úplne odlišnými entitami (variant vs. objednávka). Rozšírenie o
  ĎALŠIU prehľadávanú oblasť (napr. dodávateľov, e-maily) patrí ako TRETIE
  samostatné pole, nie zamiešané do jedného z existujúcich dvoch.
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
