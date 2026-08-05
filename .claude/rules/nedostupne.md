---
paths:
  - "apps/api/src/modules/nedostupne/**"
  - "apps/api/src/http/nedostupne-routes.ts"
  - "apps/web/src/components/NedostupneSection*.tsx"
  - "apps/web/src/nedostupneApi.ts"
---

# Nedostupné tovary (issue 176)

- **Server-side vynútenie povinného náhľadu — jednorazový `previewToken`,
  nikdy len UI konvencia.** Prvá verzia (merge candidate) spoliehala len na
  to, že React komponent volá `/preview` PRED zobrazením tlačidla "Odoslať"
  — `/send` samotné nič nekontrolovalo, takže priame API volanie mohlo
  poslať e-mail bez toho, aby čokoľvek jeho obsah niekedy zobrazilo (nájdené
  code review PRED mergom PR #182, nie testom). Oprava: `preview-tokens.ts`
  vydá krátkodobý (15 min), JEDNORAZOVÝ token viazaný na presne (orderCode,
  variantCode, emailType) pri `/preview`; `/send` ho vyžaduje a KONZUMUJE
  (zmaže) PRED čímkoľvek iným, bez ohľadu na výsledok zhody. Rovnaký
  in-process `Map` vzor ako `login-rate-limit.ts` (jedna bežiaca inštancia,
  MVP rozsah — reštart appky tokeny zruší, v poriadku). Ďalšia automatizácia
  s ticketovou podmienkou "povinný náhľad pred odoslaním" potrebuje TEN ISTÝ
  mechanizmus, nie len frontend disciplínu.
- **ŽIADNY scheduler/`enabled` prepínač, na rozdiel od #172/#173** — táto
  automatizácia nemá žiadny naplánovaný beh (ticket nič také nežiadal).
  `GET /api/nedostupne` je VŽDY živý DB dopyt, nikdy `job_run.detail` cache.
  Jednoduchšie, žiadna zbytočná zložitosť (MVP) — nová podobná automatizácia
  BEZ plánovaného behu by mala rovnako vynechať settings/`job_run` vrstvu.
- **PREKONANÉ issue 238-om (2026-08-04, ponechané pre históriu): `product.
  related_codes` (text[]) — automatický návrh náhrady zo Shoptetu (CSV
  `relatedProduct`/`relatedProduct2..8`, `catalog/map-row.ts`'s
  `extractRelatedCodes`/`MAX_ALTERNATIVES=8`), s `alternativeSearchUrl`
  vyhľadávacím fallbackom, keď appka nemala skutočnú produktovú URL.**
  Majiteľ tento CELÝ mechanizmus zamietol: *"nechcem aby to uvádzalo tieto
  náhrady - je to blbosť, to sú súvisiace produkty - nie podobné, nie
  náhrady"*. Nahradené RUČNÝMI odkazmi (bod nižšie). **issue 245 (2026-08-05)
  dokončilo follow-up: `product.related_codes` stĺpec + celé jeho populovanie
  (`map-row.ts`'s `extractRelatedCodes`/`RELATED_COLUMNS`/`MAX_ALTERNATIVES`,
  `ingest.ts`'s insert/upsert) sú ÚPLNE ODSTRÁNENÉ (incremental migrácia
  `0033_breezy_manta.sql`) — v kóde už neexistujú vôbec, nielen nečítané.
- **issue 238: majiteľove RUČNE vložené odkazy náhrad —
  `nedostupne_replacement_link` (`variant_code` PLAIN text bez FK, rovnaká
  konvencia ako `nedostupne_state`; `url`; ŽIADNY unique index).** Kľúčované
  VARIANTOM (nie `product.key` ako `product_supplier_link_override`) — screen
  aj e-mail sú per-variant granularita (`NedostupneGroup`), majiteľov nákres
  dáva pole PRI KAŽDOM TOVARE (skupina), nie pri každom čakajúcom
  zákazníckom riadku. Viac riadkov s rovnakým `variant_code` = zoznam liniek
  (`modules/nedostupne/replacement-links.ts`, zoradené `asc(createdAt)` —
  poradie vloženia, prvý pridaný je zvyčajne najviac odporúčaný). Appka k
  ručne vloženému odkazu nepozná žiadny názov/kód produktu, preto e-mailový
  `zoznam_nahrad`'s `label` je SAMOTNÁ url (`logic.ts`'s
  `buildAlternativeEmail`). Prežije nočný katalógový reimport bez ďalšej
  práce — import sa tejto tabuľky vôbec nedotýka (rovnaký zámer ako
  `nedostupne_state`/`mail_template`).
- **issue 238: preklik na náš e-shop (názov produktu) NEPOUŽÍVA
  `shopLinks.ts`'s `ourProductLink` vyhľadávací fallback, na rozdiel od
  `restock` obrazovky** — ticket žiada explicitne "ak adresu nemáme, názov
  ostane neaktívny, nikdy nevyrábať odhadom", takže `queries.ts` číta priamo
  `shop_product_url.url` (LEFT JOIN podľa `variantCode`) a frontend
  vykreslí `<a>` LEN keď nie je `null`, inak plain text. Preklik na kód
  produktu (dodávateľ) naopak ZDIEĽA existujúcu `resolveEffectiveSupplierLink`
  (`orders/effective-supplier-link.ts`) — rovnaká funkcia ako "Na
  objednanie", žiadna duplicitná logika.
- **Dedup (`nedostupne_state`) je serializovaný `NEDOSTUPNE_SEND_LOCK_KEY`
  (`787_878_006`) — bez zámku by dva súbežné klik-y na TEN ISTÝ (objednávka,
  variant, typ) mohli OBA prejsť dedup-check pred zápisom a poslať e-mail
  DVAKRÁT** (nájdené vlastným code review pred mergom). Rovnaký vzor ako
  #172/#173's RUN lock, len okolo jedného odoslania namiesto celého behu.
  `.claude/rules/scheduler.md`'s registry MUSÍ byť aktualizovaný pri KAŽDOM
  novom kľúči — 005 (`order-reminder`) aj 006 (toto issue) tam predtým
  chýbali, hoci kód sám kolízii predišiel správne.
- **`insertTestVariantForProduct` (`tests/helpers/orders.ts`) NEMÁ od issue 245
  `relatedCodes` voľbu — odstránená spolu s celým `product.related_codes`
  stĺpcom (žiadny existujúci test ju reálne používal).**
