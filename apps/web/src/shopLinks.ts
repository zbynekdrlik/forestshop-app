// Odkaz na NÁŠ produkt na eshope (issue 217).
//
// Shoptet export nemá stĺpec s adresou produktu a `guid` je UUID, nie číselné
// ID — z uložených dát sa teda priama adresa detailu poskladať nedá. Jediná
// spoľahlivá cesta je vyhľadávanie podľa kódu produktu, overené naživo na
// kódoch 60542, 1075 a 60515 (každý našiel svoj produkt).
//
// Cesta je slovenská: `/vyhledavani/` (česká podoba) vracia na tejto doméne
// 404 — nezamieňať.
const SEARCH_URL = "https://www.forestshop.sk/vyhladavanie/?string=";

export function ourProductUrl(code: string): string {
  return SEARCH_URL + encodeURIComponent(code);
}

/**
 * Odkaz na detail nášho produktu (issue 220).
 *
 * Uprednostní PRIAMU adresu z feedu pre porovnávače (obsahuje aj `?variantId=`,
 * takže otvorí rovno správnu veľkosť). Keď kód vo feede nie je — dnes 626
 * viditeľných variantov — padne späť na vyhľadávanie podľa kódu, nikdy na
 * odkaz, ktorý by viedol nikam.
 */
export function ourProductLink(code: string, feedUrl: string | null): string {
  return feedUrl === null || feedUrl === "" ? ourProductUrl(code) : feedUrl;
}

/**
 * Odkaz na náš produkt VÝHRADNE z feedu, bez dohadu (issue 329 — história
 * "Prepnuté produkty"). Na rozdiel od `ourProductLink` vyššie (padá na
 * vyhľadávanie podľa kódu) tu sa pri chýbajúcej adrese odkaz jednoducho
 * NEZOBRAZÍ — presne to majiteľ pre tento zoznam žiadal ("odkaz sa proste
 * nezobrazí"), nikdy náhradný/mŕtvy odkaz.
 */
export function feedOnlyProductLink(feedUrl: string | null): string | null {
  return feedUrl === null || feedUrl === "" ? null : feedUrl;
}
