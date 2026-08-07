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

// issue 299: šéf chce upozornenie na zásielku VRÁTENÚ ODOSIELATEĽOVI. Na
// rozdiel od `TERMINAL_STATE_CODES` vyššie toto NIE JE dôveryhodný, naživo
// potvrdený zoznam — presný stateCode, ktorým api.posta.sk hlási zásielku
// vrátenú odosielateľovi, NEBOL NIKDY naživo pozorovaný (živý probe 2026-07-25
// vrátil presne štyri kódy: received/transit/notified/delivered — "returned"
// medzi nimi nebol). "returned" je preto HYPOTÉZA, nie potvrdená hodnota —
// presne ten istý reťazec, aký stará appka (`posta_uncollected.py`, #226) aj
// TENTO modul's vlastný `terminalState` test ("hypotetické 'returned'")
// dávnejšie zvažovali ako najpravdepodobnejší tvar, no ani jeden ho nikdy
// nevidel v reálnej odpovedi. Zámerne NEPRIDANÉ do `TERMINAL_STATE_CODES`
// (`isReturnedToSender` v `logic.ts` je preto SAMOSTATNÁ funkcia, nie
// rozšírenie `terminalState`) — táto klasifikácia sa preto NIKDY necachuje
// ako trvalá (`state.ts`'s `terminalState` stĺpec ju nikdy nedostane) a
// overuje sa ZNOVA pri KAŽDOM behu, kým zásielka zostáva v 30-dňovom okne:
// keby "returned" v skutočnosti znamenalo niečo INÉ (napr. "vrátená na
// dodaciu poštu", teda STÁLE vyzdvihnuteľná — presne obava pôvodného #226
// komentára), omylom vzniknutá karta sa pri ĎALŠOM behu sama zavrie, len čo
// tracking prestane hlásiť tento kód (`run.ts`). Potvrď/oprav túto hodnotu
// naživo hneď, ako sa objaví prvá SKUTOČNÁ vrátená zásielka.
export const RETURNED_STATE_CODES: ReadonlySet<string> = new Set(["returned"]);

// Cadence e-mailov (deň 0 → +3 → +3 → +7).
export function daysNeededForNextEmail(sentCount: number): number {
  return sentCount < 3 ? 3 : 7;
}
