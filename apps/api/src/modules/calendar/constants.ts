// issue 309: "Eshop → Upozornenia" — najbližšia udalosť z majiteľovho Google
// kalendára. Krátkodobá in-memory cache PRIAMO v module (service.ts) namiesto
// nového scheduler jobu — pozri návrhový komentár na tickete
// (`gh issue comment 309`) pre celé odôvodnenie: dáta sa nemajú nikdy
// "vybaviť" ani prežiť reštart appky zmysluplne, takže netreba perzistenciu.

/** Úspešný fetch+parse sa cachuje 15 minút — osobný kalendár nepotrebuje
 * sekundovú presnosť a appka má len jedného čitateľa (majiteľa). */
export const NEXT_EVENT_OK_CACHE_TTL_MS = 15 * 60 * 1000;

/** Zlyhanie sa cachuje LEN 2 minúty — nesmie sa skúšať fetch pri KAŽDOM
 * otvorení karty počas dlhšieho výpadku, ale ani nesmie appku "zaseknúť" na
 * "nedostupné" nadlho po tom, čo sa zdroj sám spamätá. */
export const NEXT_EVENT_ERROR_CACHE_TTL_MS = 2 * 60 * 1000;

/** Okno na dopredu-expanziu opakujúcich sa udalostí (RRULE) — dosť veľké na
 * zachytenie ročne sa opakujúcej udalosti (napr. narodeniny), no konečné. */
export const RECURRENCE_EXPANSION_WINDOW_DAYS = 400;

/** issue 382: majiteľ chce vidieť TRI najbližšie udalosti, nie jednu. */
export const NEXT_EVENTS_LIMIT = 3;

/** Strop veľkosti stiahnutého ICS tela — osobný kalendár je rádovo KB až
 * jednotky MB; 10 MB je veľkorysá, no konečná hranica proti
 * nepriateľskému/pokazenému serveru (rovnaký princíp ako `catalog/
 * fetcher.ts`'s `DEFAULT_MAX_EXPORT_BYTES`). */
export const MAX_ICS_BYTES = 10 * 1024 * 1024;

export const ICS_FETCH_TIMEOUT_MS = 10_000;
