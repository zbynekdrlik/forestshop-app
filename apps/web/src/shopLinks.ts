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
