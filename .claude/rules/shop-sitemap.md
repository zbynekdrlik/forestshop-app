---
paths:
  - "apps/api/src/modules/shop-sitemap/**"
  - "apps/api/src/db/schema-shop-feed.ts"
  - "apps/api/src/http/shop-sitemap-routes.ts"
  - "apps/web/src/components/PairingReviewCard.tsx"
---

# Adresy z sitemapy + HTTP sonda (issue 402) — ODSTRÁNENÉ (issue 598, 20. 11. 2026)

- **Job `shop-sitemap`, jeho modul (`modules/shop-sitemap/`) aj trasy `/api/shop-sitemap/*`
  sú odstránené** (ROZHODNUTÉ majiteľom 20. 11. 2026, možnosť 1). Hádanie adries
  produktov na forestshop.sk spúšťalo ~4 h blok IP servera Shoptetom (`shoptet-http.md`).
  Majiteľ odkazy na vypnuté produkty nepotrebuje.
- **Existujúce riadky `shop_product_url.source IN ('sitemap','probe')` ostali** (~3 000),
  nové už nepribúdajú; feed ich naďalej reklamuje na `feed` (`shop-feed/run.ts`). Tabuľka
  `shop_sitemap_probe_attempt` ostala bez zápisov (žiadna migrácia na jej zrušenie).
- Kód je v histórii gitu pred mergom PR k issue 598 (port `url_resolver.py`), ak by bolo
  treba niečo obnoviť — nikdy NIE s hádaním adries na forestshop.sk.
- `PairingReviewCard.tsx`'s vizuálne odlíšený vyhľadávací fallback (`ourUrlIsSearchFallback`)
  ostáva — pokrýva produkty bez odkazu z feedu.
