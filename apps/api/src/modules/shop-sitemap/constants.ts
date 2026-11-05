// issue 402: doplnkový beh nad `shop_product_url` (issue 220) — sitemap.xml +
// HTTP sonda kandidátnych slugov pre kódy, ktoré `shop-feed` (google.xml)
// nepokrýva. Rovnaký vzor konštánt ako `shop-feed/constants.ts`/
// `pairing-search/constants.ts`.

export const SHOP_SITEMAP_JOB_NAME = "shop-sitemap";

// Veľkosť dávky pri hromadnom zápise (`shop_product_url`, `shop_sitemap_probe_attempt`).
export const DB_WRITE_CHUNK = 500;

// Verejná adresa sitemapy — NIE je to prihlasovací údaj, smie byť v
// repozitári (rovnaká úvaha ako `shop-feed/constants.ts`'s `DEFAULT_SHOP_
// FEED_URL`). Prepísateľná premennou prostredia pre prípad zmeny.
export const DEFAULT_SITEMAP_URL = "https://www.forestshop.sk/sitemap.xml";

export const REQUEST_TIMEOUT_MS = 30_000;

// Sitemapa má dnes ~3.3 MB (`.claude/rules/pairing-search.md`: "3262 loc,
// s obrázkami"). Strop je zámerne veľkorysý, rovnaká úvaha ako `shop-feed`/
// `catalog/fetcher.ts`.
export const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

// Poistka proti prázdnej/pokazenej sitemape — rovnaký princíp ako `shop-
// feed/constants.ts`'s `MIN_ENTRIES`, len nižšia hranica (sitemapa je menšia
// množina než feed — pokrýva len publikované produkty, nie všetky varianty).
export const MIN_SITEMAP_LOCS = 500;

// Throttle medzi HTTP sondami kandidátnych slugov. issue 598: pôvodne 300 ms
// („vlastný e-shop, nie tretia strana") — lenže e-shop beží na Shoptete, ktorého
// WAF od 21. 10. 2026 blokuje IP servera ako útok. 300 ms + ~0,1–0,5 s odozva
// = ~2 požiadavky/s po celých 15 minút. Teraz 1 s (rovnaký rád ako
// `pairing-search/client.ts`'s 0,7 s voči cudzím serverom).
export const PROBE_THROTTLE_MS = 1000;

// issue 598: tvrdý strop HTTP sond na JEDEN beh (nezávisle od času). S
// throttlom 1 s je to ~5 min a ~60 produktov (4–5 kandidátov na produkt) za
// noc. Populácia bez adresy (PROD 25. 10. 2026: 1 291 produktov) sa tak prejde
// postupne za ~3 týždne a potom ju drží `PROBE_COOLDOWN_DAYS`.
export const MAX_PROBE_REQUESTS_PER_RUN = 300;

// issue 598: produkt, pre ktorý sonda nenašla živú stránku, sa znova skúsi
// najskôr po toľkých dňoch (`shop_sitemap_probe_attempt`). Nový produkt v
// katalógu (žiadny pokus) ide vždy prvý. Sitemap prechod (1 požiadavka, celá
// sitemapa) beží pre VŠETKY chýbajúce produkty každú noc bez ohľadu na toto.
export const PROBE_COOLDOWN_DAYS = 30;

// Časový (nie počtový) strop JEDNÉHO behu — rovnaký dôvod ako `pairing-
// search/constants.ts`'s `RUN_TIME_BUDGET_MS`: nákladový faktor je sieťový
// čas (počet kandidátov na produkt × throttle), nie počet produktov. Beh,
// ktorý prekročí rozpočet, sa zastaví PO dokončení aktuálneho produktu a
// pokračuje nasledujúcu noc (produkty bez riadku ostávajú v populácii
// ĎALŠIEHO behu — `select.ts`).
export const RUN_TIME_BUDGET_MS = 15 * 60_000;

// `.claude/rules/scheduler.md`'s registr: 787_878_001..009 + 100 sú
// obsadené (over VŽDY priamo v kóde, `grep -rn "787_878_0" apps/api/src` —
// playbook môže zaostávať, presne ako `pairing-search`'s vlastná poučka).
// Session-scoped (nie transakčný) — beh robí desiatky sekvenčných HTTP
// sond, rovnaký dôvod ako `PAIRING_SEARCH_RUN_LOCK_KEY`/`POSTA_UNCOLLECTED_
// RUN_LOCK_KEY`: držať jednu DB transakciu otvorenú počas sieťových volaní
// by zbytočne zaťažovalo connection pool.
export const SHOP_SITEMAP_RUN_LOCK_KEY = 787_878_010;
