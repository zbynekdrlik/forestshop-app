---
paths:
  - "apps/api/src/modules/shop-sitemap/**"
  - "apps/api/src/db/schema-shop-feed.ts"
  - "apps/api/src/http/shop-sitemap-routes.ts"
  - "apps/web/src/components/PairingReviewCard.tsx"
---

# Adresy z sitemapy + HTTP sonda (issue 402 — doplnok k `shop-feed.md`)

Doplnkový beh k feedu (issue 220): `shop-feed` pokrýva len ~7 700/14 200
variantov, zvyšok (najmä `discontinued`/vypnuté produkty) padal na
vyhľadávací fallback na karte "Eshop → Párovanie". Port starej appky
(`parovanie_produktov` @ HEAD, `src/parovanie/url_resolver.py` +
`scripts/resolve_urls.py`): sitemap.xml prechod (zadarmo) → HTTP sonda
kandidátnych slugov (časovo rozpočtovaná) pre zvyšok.

- **`slug()`/`candidateSlugs()` sú byte-for-byte overené proti NAINŠTALOVANEJ
  starej appke** (`PYTHONPATH=src:scripts python3 -c "from resolve_urls
  import candidates; ..."`, viď `.claude/rules/pairing-search.md`'s rovnaká
  disciplína pre `token-set-ratio.ts`) — nie len proti vlastnej intuícii o
  algoritme. Test pri ĎALŠEJ zmene: over znova, nikdy neuprav bez porovnania.
- **Disambiguácia je ZÁMERNE upravená oproti starej appke — BEZ obrázkov.**
  Táto appka's katalógový import (`catalog/map-row.ts`) neukladá produktové
  obrázky (Shoptet CSV ich má, appka ich nečíta) — pridávanie zachytávania
  obrázkov je mimo rozsahu tohto ticketu (súbežný worker #397 pracuje na
  presne tejto "bez obrázka" medzere na TEJ ISTEJ karte). Náhrada:
  `disambiguateByTokens()` vyberie kandidáta s NAJMENEJ nevysvetlenými
  tokenmi navyše oproti PRODUKTOVÉMU MENU (nie obrázku); bez jednoznačného
  víťaza `null` (rovnaká "zlý odkaz je horší než žiadny" zásada).
- **`shop_product_url.source` (`feed`/`sitemap`/`probe`, issue 402) je to, čo
  drží dva behy oddelené bez toho, aby si prekážali.** `shop-feed/run.ts`'s
  UPSERT PREPÍŠE `source` na `'feed'` pri KAŽDOM behu (aj keď kód predtým
  patril `shop-sitemap`u — feed je autoritatívny, reklamuje kód späť, hneď
  ako ho pokryje). `shop-sitemap/run.ts` naopak zapisuje LEN kódy BEZ
  akéhokoľvek existujúceho riadku (`select.ts`'s `selectMissingProducts`) a
  používa `onConflictDoNothing` (nikdy `onConflictDoUpdate`) — dvojitá
  poistka, že nikdy neprepíše feedom potvrdený riadok, aj keby `select.ts`
  medzi čítaním a zápisom niečo prehliadol.
- **Cross-run dedup sentinel:** `selectExistingSitemapProbeUrls` (LEN
  `source IN ('sitemap','probe')`, nikdy `feed` — feedové URL nesú
  `?variantId=…` a s holým produktovým slugom sa prakticky nikdy
  nezhodujú) dodá URL už priradené PREDOŠLÝM behom ako `STRENGTH_EXISTING`
  sentinel do `dedup()`u — produkt vyriešený DNES nikdy neukradne URL
  produktu vyriešeného VČERA.
- **Advisory zámok `787_878_010`** (`SHOP_SITEMAP_RUN_LOCK_KEY`) — ĎALŠÍ
  voľný kľúč, over VŽDY `grep -rn "787_878_0" apps/api/src` priamo v kóde
  pred pridaním ĎALŠIEHO (playbook môže zaostávať, `.claude/rules/
  scheduler.md`'s vlastná poučka). Potrebný, lebo job MÁ manuálny "Spustiť
  teraz" (`POST /api/shop-sitemap/run-now`) na TÚ ISTÚ prácu ako nočný beh.
- **Scheduler slot je 04:05, NIE 04:20** (pôvodný dispatch navrhol 04:20 —
  ten už patrí `supplierStockJob`u). 04:05 = 15 min PO `shop-feed`e (03:50)
  A 15 min PRED `supplierStockJob`om (04:20), spĺňa "aspoň 15 min od
  suseda" (`.claude/rules/scheduler.md`).
- **`PairingReviewCard.tsx`'s vyhľadávací fallback je teraz vizuálne
  odlíšený** — nový `PairingReviewItem.ourUrlIsSearchFallback: boolean`
  pole (počítané v `pairing-review/queries.ts`, PRED priradením fallback
  URL), frontend podľa neho pridá `.pairing-review-name-fallback` triedu +
  samostatnú `.pairing-review-fallback-note` poznámku (farba nikdy nie je
  jediný signál). Zdieľaná karta s issue #397 (obrázky) — zmena je
  minimálna a nedotýka sa obrázkového bloku vôbec.
- **Živé smoke overenie BEZ SSH — appka beží PRIAMO na `forestshop-dev`,
  takže `docker exec forestshop-postgres-1 psql ...` (produkčný kontajner,
  READ-ONLY dopyt) funguje LOKÁLNE, žiadny `ssh admin@forestshop-dev...`
  netreba** (ten by aj tak zlyhal — žiadny privátny kľúč pre spätné
  spojenie na seba samého). Over `hostname`/`docker ps` PRED siahnutím po
  `ssh` vzoru z `.claude/rules/deploy.md` — tie príkazy sú písané pre
  reláciu bežiacu MIMO tohto stroja.
- **Skript proti PRODUKČNÉMU forestshop.sk (`fetch("https://www.forestshop.sk/sitemap.xml")`,
  HTTP sonda kandidátov) je bezpečný — verejné GET požiadavky, žiadny zápis,
  žiadne prihlasovacie údaje.** 6 reálnych sellable produktov vzorkovaných
  priamo z produkčnej DB (bez shop_product_url pokrytia): 4/6 vyriešených
  sitemap prechodom, 2/6 nevyriešené — nezávisle potvrdené `curl`om ako
  genuinly 404 (produkt nemá žiadnu nájditeľnú živú stránku pod žiadnym
  rozumným kandidátom), nie medzera v algoritme.
- **POZOR — tento box (`forestshop-dev`) hostí PRODUKCIU AJ vývoj na 2
  jadrách** (`.claude/rules/deploy.md`'s "Vývoj a produkcia bežia na TOM
  ISTOM stroji" — reálny 502 výpadok 12. 8. 2026 z `pnpm -r test`).
  `pnpm --filter @forestshop/api test:integration` (celá sada, ~500 s)
  spustená priamo tu je v poriadku SKÚPO/výnimočne (cgroup CPUWeight
  chráni produkciu, over `curl .../api/version` PRED aj PO), ale
  NEOPAKUJ ju zbytočne — jeden beh na overenie stačí, ďalšie overenia rob
  SCOPED (konkrétne dotknuté súbory), nikdy plnú sadu znova len "pre
  istotu". `e2e` (Playwright, 2 dev servery + prehliadač) sa na tomto
  boxe lokálne VYNECHÁVA, keď je súbežná záťaž vysoká (`ps aux | grep
  vitest|playwright` + `cat /proc/loadavg`) — CI ju aj tak spustí
  bezpodmienečne.
