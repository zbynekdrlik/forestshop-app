// issue 387 E3: konštanty gather behu.

export const PAIRING_SEARCH_JOB_NAME = "pairing-search";
export const PAIRING_SEARCH_SETTINGS_ID = "default";

// Návrh (sekcia 5, bod 3) aj zadanie tejto etapy pôvodne menovali
// "787_878_007" — REVIEW NÁLEZ (issue 387 E3): ten kľúč UŽ patrí
// `SUPPLIER_STOCK_RUN_LOCK_KEY` (`supplier-stock/constants.ts`, issue 212,
// zmergované dávno pred touto etapou) — `.claude/rules/scheduler.md`'s
// vlastný registr bol v čase návrhu zastaraný (nezahŕňal `007` ani `008`
// [`RESTOCK_RUN_LOCK_KEY`]), takže kolízia prešla nepovšimnutá. Postgres
// advisory zámky zdieľajú JEDEN priestor kľúčov bez ohľadu na to, ktorý
// modul ich vzal — bez opravy by súbežný beh gatheru a `supplier-stock`
// scrapera (oba session-scoped, oba môžu bežať dlho) NAVZÁJOM ZABLOKOVAL
// bez timeoutu. `009` je prvý skutočne voľný kľúč (over `.claude/rules/
// scheduler.md`'s aktualizovaný registr pred ĎALŠÍM pridaním). Session-
// scoped (nie transakčný), rovnaký vzor ako `posta-uncollected/run.ts`'s
// `POSTA_UNCOLLECTED_RUN_LOCK_KEY` — beh robí desiatky sekvenčných
// sieťových volaní na dodávateľov, držať jednu DB transakciu otvorenú
// počas nich by zbytočne zaťažovalo connection pool.
export const PAIRING_SEARCH_RUN_LOCK_KEY = 787_878_009;

// Top-K kandidátov ponechaných po ranku (návrh: "top-K = 8, únia všetkých
// query_variants") — port starej appky's `gather_candidates(..., k=8)`.
export const CANDIDATE_LIMIT = 8;

// Časový (nie počtový) strop JEDNÉHO behu — nákladový faktor gatheru je
// SIEŤOVÝ ČAS na produkt (viac query variantov × throttle 0,7s × až 3
// retry), ktorý sa medzi produktmi výrazne líši, takže počtový strop
// (`restock`'s `MAX_PER_RUN` vzor) by negarantoval predvídateľnú dĺžku
// behu (design komentár na tickete, "Zamietnutá alternatíva"). Beh, ktorý
// prekročí tento rozpočet, sa PO dokončení AKTUÁLNEHO produktu (nikdy
// uprostred jeho transakcie) zastaví — `stoppedEarly: true` v
// `job_run.detail` — a pokračuje nasledujúcu noc odtiaľ, kde skončil
// (`input_hash` inkrementálnosť, `select.ts`).
export const RUN_TIME_BUDGET_MS = 20 * 60_000;
