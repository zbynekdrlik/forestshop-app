---
paths:
  - "apps/api/src/modules/floor-notes/**"
  - "apps/api/src/db/schema-floor-notes.ts"
  - "apps/api/src/http/floor-notes-routes.ts"
  - "apps/web/src/floorNotesApi.ts"
  - "apps/web/src/autoResizeTextarea.ts"
  - "apps/web/src/components/FloorNotesSection.tsx"
  - "apps/web/src/components/FloorNoteRow.tsx"
  - "apps/web/src/components/FloorNoteProductChip.tsx"
  - "apps/web/src/components/FloorNoteProductSearch.tsx"
---

# Eshop → Objednávky predajňa (issue 410 — nahradilo issue 345)

Nahrádza Štěpánovo Discord vlákno vlastnými zápismi z predajne. Predchádzajúci Shoptet-viazaný
zoznam (`shipping_carrier_name ILIKE '%Osobný odber%'`, issue 345) bol ÚPLNE odstránený —
`floor-orders-queries.ts`/`floor-orders-routes.ts`/`floorOrdersApi.ts`/`FloorOrdersSection.tsx` +
ich testy/fixtúry už neexistujú. Nav `id: "floor-orders"`/label "Objednávky predajňa" ostali
nezmenené — mení sa len obsah obrazovky (`Component` v `nav.ts`), nie jej miesto v menu.

- **Zápis je kľúčovaný `floor_note` (voľný text + 3 nezávislé boolean značky `resolved`/`ordered`/
  `called`, žiadna ďalšia funkcia) + junction `floor_note_product`, kľúčovaná `variant.code` (NIE
  `product.key`)** — vyhľadávacie výsledky ("Vyhľadať") sú per-VARIANT a `shop_product_url` je TIEŽ
  kľúčovaná variantovým kódom, takže pripnutie na úrovni variantu drží presnú veľkosť + priama linka
  je jednostĺpcový JOIN. Unique index `(floor_note_id, variant_code)` + `onConflictDoNothing()` robí
  opakované "Pripnúť" idempotentné (nie chybu).
- **Pripínanie produktu ZNOVUPOUŽÍVA `globalSearch()` z `searchApi.ts`** (frontend zavolá
  `GET /api/search?q=...` a číta len `.products` polovicu odpovede) — žiadna nová backendová
  vyhľadávacia cesta. `FloorNoteProductSearch.tsx` je tenká obálka nad tým istým klientom, akého
  používa `SearchSection.tsx`.
- **Detailový odkaz na pripnutý produkt ZNOVUPOUŽÍVA `ourProductLink()` z `shopLinks.ts`**
  (backend vráti raw `shop_product_url.url | null` cez LEFT JOIN v `queries.ts`'s `listFloorNotes`)
  — frontend počíta `isFallback = shopUrl === null` a pri `true` pridá `.floor-note-product-link-
  fallback` (tlmená farba + prerušovaná čiara) + explicitnú poznámku "🔎 hľadať na eshope", presne
  ten istý vzor ako `PairingReviewCard.tsx` po issue 402 — NIKDY plain-vyzerajúci odkaz, keď priama
  adresa nie je známa.
- **Zápis je gejtovaný `requireRole("admin","manazer")` na KAŽDEJ zapisovacej trase** (vytvoriť/
  upraviť text/prepnúť značku ×3/pripnúť-odopnúť produkt/zmazať), čítanie len `requireUser` —
  rovnaký štandard ako 53+ iných zapisovacích trás v tejto appke. Frontend (`FloorNotesSection.tsx`'s
  `canEdit = CAN_EDIT_ROLES.has(role)`) zrkadlí to v UI: **značky ostávajú VIDITEĽNÉ ale `disabled`**
  pre "citanie" rolu (nesú informáciu o stave, čítanie nie je gejtované), zatiaľ čo upraviť/zmazať/
  pripnúť/odopnúť sú PLNE SKRYTÉ (nulová informačná hodnota v disabled stave) — rovnaký vzor ako
  `UpozorneniaSection.tsx`'s `CONTROL_ROLES`.
- **Rastúca textarea (Enter/Shift+Enter len pridá nový riadok, formulár sa NIKDY neodošle Enterom)
  je takmer ZADARMO** — `<textarea>` už sama osebe pri OBOCH klávesách len vloží nový riadok a
  NIKDY neodošle formulár (na rozdiel od `<input>`u), appka preto nezachytáva žiadnu klávesu vôbec.
  `autoResizeTextarea.ts` len RUČNE prispôsobí `style.height` pri `onChange` (žiadny CSS-only
  `field-sizing: content` — nie je isté, že appka smie spoliehať len na prehliadače, čo ho
  podporujú). Test na tento helper MUSÍ mockovať `scrollHeight` (`Object.defineProperty`) — jsdom ho
  vždy vráti `0`, skutočný rast sa dokazuje AŽ e2e testom.
- **E2E fixtúra (`scripts/e2e-fixtures-floor-notes.ts`) seeduje DVA varianty naschvál — jeden SO
  `shop_product_url` riadkom, jeden BEZ neho** — jediný spôsob, ako v jednom e2e behu dokázať OBE
  vetvy detailového odkazu (priamy vs. vizuálne odlíšený náhradný). Vlastný izolovaný e2e účet
  (`E2E_PREDAJNA_EMAIL`) je ZNOVUPOUŽITÝ e-mail z pôvodnej (issue 345) fixtúry — tá bola odstránená
  spolu s obrazovkou, takže žiadny nárast rate-limit rozpočtu (`.claude/rules/testing.md`'s
  `MAX_ATTEMPTS` disciplína).
- **Pridanie E2E fixtúrových variantov PRIAMO do `product`/`variant` tabuliek (nie cez katalógový
  import) posúva `catalog.spec.ts`'s pevné počty** — rovnaká past, akú `.claude/rules/testing.md`
  už dokumentuje (issue 217/337/atď). Issue 410 pridalo 2 `sellable` varianty: `103→105` (celkový
  počet) a `73→75` (sellable filter). Vzor pri KAŽDEJ ďalšej novej fixtúre, čo vkladá `product`/
  `variant` riadky mimo katalógového importu: zvýš OBE čísla v `catalog.spec.ts` presne o počet
  pridaných variantov a napíš do komentára odkiaľ sa nárast vzal — inak celý e2e balík spadne na
  4 nesúvisiace testy v `catalog.spec.ts`, hoci diff sa katalógu vôbec nedotkol.
- **`floor_note`/`floor_note_product` sú pridané do OBOCH TRUNCATE zoznamov** (`scripts/e2e-setup.ts`
  aj `apps/api/tests/helpers/db.ts`) — `apps/api/src/db/truncate-list-completeness.test.ts` (issue
  384) by inak spadol automaticky, over ho ako prvý signál pri KAŽDEJ ďalšej novej "koreňovej"
  tabuľke namiesto ručného hľadania.
- **Počet kusov pripnutého produktu je stĺpec `floor_note_product.quantity` (int NOT NULL DEFAULT 1,
  CHECK `>= 1`, migrácia `0057`; issue 453)** — DVE miesta ho nastavujú: vstup pri pripínaní vo
  výsledku hľadania (`FloorNoteProductSearch.tsx`) a inline editovateľný spinbutton v zozname
  (`FloorNoteProductChip.tsx`), ktorý PATCHuje pri zmene — obe cez tú istú zapisovaciu cestu.
  API validuje `quantity >= 1` zhodne s DB CHECK (0/záporné odmietne), takže prípadné budúce
  „zníž na 0 = odober" MUSÍ produkt ODOPNÚŤ (delete riadku), nie nastaviť `quantity = 0`.
  Existujúce riadky pred 0057 dostali backfill DEFAULT 1; v zozname sa renderuje ako „N ks".
- **Predajňové položky (🛍️) v board-e „Na objednanie" (issue 480):** produkty
  pripnuté na NEVYBAVENÝCH zápisoch sa zobrazia aj v „Na objednanie" pod svojím
  dodávateľom, aby sa objednali spolu s e-shopovými. Kľúčové body:
  - **Zoskupenie:** `orders/queries.ts`'s `listOpenOrderLinesBySupplier` pridáva
    `floorRows` do KAŽDEJ dodávateľskej skupiny cez TÚ ISTÚ efektívnu cestu ako
    `order_line` (`effectiveSupplierSql` = coalesce `products.supplier`,
    `product_supplier_override`; variantCode → `variants.productKey` → products).
    Pridávajú sa LEN keď `stateFilter === undefined` (board „Na objednanie"),
    NIKDY do sekcie „Riešiť". Produkt bez dodávateľa → skupina
    `NEZNAMY_DODAVATEL`. Skupina LEN s floor riadkami (žiadne objednávky) je
    plnohodnotná; triedenie skupín berie max z `lines[0].placedAt` a
    `floorRows[0].createdAt`. **Zobrazia sa aj bez nastavených otvorených stavov
    objednávok** — early-return `openStatuses.length === 0` platí len pre
    „Riešiť"; pre „Na objednanie" sa order-line dopyt preskočí (`? [] :`), floor
    riadky sa pridajú aj tak (floor sú od otvorených stavov nezávislé).
  - **`floor_note_product.ordered_at`** (nullable timestamp, migrácia 0059,
    NULL = neobjednané) — jediná „vybavené" sémantika floor riadku (žiadny stav).
  - **`floor_note.ordered` (🛒) je ODVODENÉ** — `recomputeFloorNoteOrdered`
    (`service.ts`): true práve keď má zápis ≥1 položku a VŠETKY majú `ordered_at`.
    Volá sa pri per-item ordered zmene (`setFloorNoteProductOrdered`,
    `POST /api/floor-notes/:id/products/:variantCode/ordered`), pri hromadnej
    `setSupplierLinesOrdered` (orders/state.ts — zahŕňa floor riadky skupiny),
    AJ pri attach/detach (attach/detach sú preto v transakcii). Ručný 🛒
    prepínač ostáva, ale zmena množiny/objednanosti položiek ho prepočíta.
    NEbumpuje `updated_at` (odvodený dôsledok junction riadku, ako
    `updateFloorNoteProductQuantity`).
  - **Web:** `FloorOrderRow.tsx` (rovnakých 9 stĺpcov ako order riadok, 🛍️ +
    odkaz `?tab=floor-orders` NAMIESTO čísla objednávky, žiadne stavové tlačidlá,
    testid `floor-order-row-<noteId>-<variantCode>` — ZÁMERNE nie prefix
    `order-line-`). `SupplierOpenOrders.floorRows` je v `ordersApi.ts`
    `.optional()` (desiatky starých test-literálov `{supplier,lines,email}` bez
    tohto poľa) — VŠETCI konzumenti čítajú `floorRows ?? []`. Odznak
    „Na objednanie", filter „skryť vybavené" (`isFloorRowHidden`), čipy
    `OrdersToolbar` aj hromadné tlačidlo `SupplierActionsPanel` musia floor riadky
    ZAHŕŇAŤ (inak chip↔panel drift, issue 263 invariant). E-mail dodávateľovi
    floor riadky NEZAHŔŇA (`mail.ts` číta len `order_line`).
