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
- **Voľnému textu stránky sa dôveruje LEN na doménach v `TRUSTED_TEXT_HOSTS`.**
  Slovo „Skladom" sa na cudzej stránke môže vyskytnúť v pätičke, v menu alebo
  pri inom produkte. Pridanie novej domény do zoznamu vyžaduje overenie na
  uloženej vzorke tej stránky, nikdy len domnienku.
- **Obe polia dostupnosti sa do Shoptetu zapisujú NARAZ.** Shoptet zobrazuje
  `availabilityOutOfStock` v momente, keď sklad klesne na nulu, takže zápis
  len do `availabilityInStock` nechá po dopredaní fiktívnych kusov naskočiť
  staré „Vypredané" (overené v ostrej prevádzke starej appky 14. 7. 2026).
  Preto aj kladný `stock` — pri nule je prepnutie bez efektu.
- **Nová cesta zápisu CSV do Shoptetu patrí do `shoptet-writeback/csv.ts`, aj
  keď má úplne iné stĺpce** (`buildRestockCsv` vedľa `buildWritebackCsv`) —
  ochrana proti CSV injection (`dataRowToLine`) musí platiť pre KAŽDÚ cestu,
  nikdy sa stĺpce neskladajú mimo tohto modulu.
- **Nová tabuľka MUSÍ pribudnúť do `TRUNCATE` zoznamu v
  `tests/helpers/db.ts`, inak testy zlyhajú AŽ pri druhom behu.** Pri #212 to
  bolo obzvlášť zákerné: prvý beh prešiel (prázdna tabuľka), druhý beh našiel
  vlastné čerstvé zápisy z prvého behu, vyhodnotil ich ako platné potvrdenia
  a preskočil VŠETKY odkazy — testy padli na „skipped 2, checked 0" bez
  akejkoľvek zmeny kódu.
