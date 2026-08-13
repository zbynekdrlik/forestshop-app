// issue 387 E3: konštanty gather behu.

export const PAIRING_SEARCH_JOB_NAME = "pairing-search";
export const PAIRING_SEARCH_SETTINGS_ID = "default";

// Ďalší voľný kľúč v registri (`.claude/rules/scheduler.md`) — schválený
// priamo v návrhu (sekcia 5, bod 3): "session-scoped advisory lock
// 787_878_007". Session-scoped (nie transakčný), rovnaký vzor ako
// `posta-uncollected/run.ts`'s `POSTA_UNCOLLECTED_RUN_LOCK_KEY` — beh robí
// desiatky sekvenčných sieťových volaní na dodávateľov, držať jednu DB
// transakciu otvorenú počas nich by zbytočne zaťažovalo connection pool.
export const PAIRING_SEARCH_RUN_LOCK_KEY = 787_878_007;

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
