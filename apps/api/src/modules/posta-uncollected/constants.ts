// issue 172: "Nevyzdvihnuté zásielky" — verné konštanty prevzaté zo starej
// appky (`parovanie_produktov/src/parovanie/posta_uncollected.py`), preto
// komentáre na viacerých miestach cituju presne odtiaľ (číselné prahy sú tam
// kalibrované na reálnej histórii, nie hádané — pozri ten súbor pre plné
// odôvodnenie).

// Netreba env premennú — tretia strana (Slovenská pošta), fixná adresa,
// nikdy sa nemení (rovnaký zámer, aký mala stará appka).
export const TRACKING_API_URL_TEMPLATE = "https://api.posta.sk/tracking?q={q}&l=sk&p=1";
export const TRACKING_LINK_TEMPLATE = "https://www.posta.sk/sledovanie-zasielok#parcel={q}";

export function trackingApiUrl(packageNumber: string): string {
  return TRACKING_API_URL_TEMPLATE.replace("{q}", encodeURIComponent(packageNumber));
}

export function trackingLink(packageNumber: string): string {
  return TRACKING_LINK_TEMPLATE.replace("{q}", encodeURIComponent(packageNumber));
}

export const SOURCE_WINDOW_DAYS = 30;
export const MAX_EMAILS = 4;

// Non-Pošta dopravcovia rozpoznaní v mene SHIPPING pseudo-položky
// (case-insensitive substring zhoda) — DPD je jediný naživo potvrdený
// (stará appka #126), zvyšok je defenzívne pridaný podľa ticketu ("DPD a
// ďalší kuriéri"). Osobný odber je na tomto zozname tiež, hoci to nie je
// kuriér — jednoducho tam nie je žiadna zásielka na sledovanie.
export const NON_POSTA_CARRIER_KEYWORDS: readonly string[] = Object.freeze([
  "dpd",
  "gls",
  "packeta",
  "zásielkov",
  "zasielkov",
  "in time",
  "intime",
  "wedo",
  "spservis",
  "osobný odber",
  "osobny odber",
]);

// Predvolené (zámerne NEnastaviteľné v tomto tickete — pozri návrhový
// komentár na tickete, "Zamietnuté alternatívy") zoznamy stavov objednávky.
export const DISPATCHED_STATUSES: ReadonlySet<string> = new Set(["Vybavená"]);
export const CANCELLED_STATUSES: ReadonlySet<string> = new Set(["Stornovaná"]);

// Coverage/blind-spot poistka (#282/#298 v starej appke) — kalibrované
// prahy, viď `posta_uncollected.py`'s obšírny komentár pri týchto
// konštantách pre plné odôvodnenie čísel.
export const MIN_PACKAGE_COVERAGE = 0.5;
export const MAX_PACKAGE_GAP_DAYS = 7;
export const MIN_DISPATCHED_FOR_ALARM = 5;
export const MIN_ELIGIBLE_FOR_BLIND_SPOT = 20;

// Terminálne (už sa nemenia) stavy sledovania — `notified` je ZÁMERNE
// CHÝBAJÚCI (to je stav, ktorý táto automatizácia práve sleduje). "returned"
// nebol nikdy naživo pozorovaný, preto sa NEDÔVERUJE (stará appka #226) —
// akýkoľvek nerozpoznaný kód sa berie ako "ešte sa môže zmeniť".
export const TERMINAL_STATE_CODES: ReadonlySet<string> = new Set(["delivered"]);

// Koľko dní sa terminálny stav nechá "zapamätaný" bez opätovného overenia
// (stará appka #222 — výkon, nesledovanie už doručených zásielok).
export const TERMINAL_CACHE_DAYS = 7;

// Cadence e-mailov (deň 0 → +3 → +3 → +7).
export function daysNeededForNextEmail(sentCount: number): number {
  return sentCount < 3 ? 3 : 7;
}
