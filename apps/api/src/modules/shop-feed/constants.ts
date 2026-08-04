// issue 220: mapa „kód variantu → adresa detailu na našom e-shope".
//
// Majiteľ o dovtedajších odkazoch (vyhľadávanie podľa kódu): „tie linky na
// nase produkty su uplne hrozne". Priama adresa sa z exportu poskladať nedá,
// ale Shoptet ju publikuje vo feede pre porovnávače.

export const SHOP_FEED_JOB_NAME = "shop-feed";

// Verejná adresa feedu — NIE je to prihlasovací údaj (na rozdiel od
// `SHOPTET_EXPORT_URL`, ktorá nesie `hash`), takže smie byť v repozitári.
// Prepísateľná premennou prostredia pre prípad, že Shoptet adresu zmení,
// bez nutnosti nasadzovať novú verziu.
export const DEFAULT_SHOP_FEED_URL = "https://www.forestshop.sk/google.xml";

export const REQUEST_TIMEOUT_MS = 60_000;

// Feed má dnes ~12 MB. Strop je zámerne veľkorysý voči tomu, ale konečný —
// rovnaká úvaha ako `catalog/fetcher.ts`: pokazený server nesmie vyčerpať
// pamäť kontajnera.
export const MAX_FEED_BYTES = 100 * 1024 * 1024;

// Poistka proti prázdnemu/pokazenému feedu: keď sa rozobralo menej položiek
// než toto, mapa sa NEPREPÍŠE a beh skončí chybou. Bez nej by jeden
// pokazený beh zmazal všetky adresy a odkazy na obrazovke by sa ticho
// vrátili na vyhľadávanie. Dnešný feed má 7666 položiek.
export const MIN_ENTRIES = 1_000;
