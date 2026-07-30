// Extrakcia odkazu na tovar u dodávateľa z export's `internalNote`
// (`product.internalNote`, `schema-catalog.ts` — issue 67). ČISTÁ funkcia,
// volaná AŽ pri ČÍTANÍ (`modules/orders/queries.ts`, `modules/orders/
// mail.ts`), nikdy pri importe — žiadny ďalší odvodený stĺpec v DB, takže
// budúca zmena tejto extrakcie sa prejaví okamžite na všetkých zobrazeniach,
// bez potreby re-importu.
//
// Na reálnom exporte (14 014 riadkov) má `internalNote` tri tvary:
//  - prázdne — dodávateľ odkaz vôbec neuviedol ("odkaz nemáme", nie chyba).
//  - holý odkaz (`https://www.huntingshop.eu/fairfax-fz-mikina`).
//  - text s popisom OBSAHUJÚCI odkaz (`Dodávateľ: Trigona - https://trigona.sk/...`).
//  - text BEZ odkazu, len poznámka (`Soxland`) — zobrazí sa ako obyčajný text.

export interface SupplierLink {
  /** Extrahovaný odkaz, alebo `null`, keď v pôvodnom texte žiadny nie je. */
  readonly url: string | null;
  /**
   * Pôvodný text `internalNote` (orezaný), pre zobrazenie ako plain-text
   * fallback, keď `url` je `null` — inak `null` (prázdny/neprítomný vstup).
   */
  readonly note: string | null;
}

const URL_RE = /https?:\/\/\S+/i;

// `internalNote` je ručne písaný voľný text (issue 70) — URL v ňom je bežne
// nasledovaná koncovou interpunkciou ("...produkt.") alebo uzatvorená v
// zátvorke/úvodzovkách ("(pozri https://...)"), ktorá do samotného odkazu
// nepatrí. `URL_RE`'s `\S+` je pažravý a zoberie ju tiež, preto sa taký beh
// znakov po matchi orežú. Poznámka s VIACERÝMI odkazmi (issue 70's test)
// zámerne berie len PRVÝ výskyt — žiadny zoznam odkazov sa v UI zatiaľ
// nezobrazuje.
//
// Neborovkovaná (non-bracket) interpunkcia sa orezáva VŽDY bez podmienky —
// nikdy nie je legitímnou súčasťou URL cesty v tomto exporte.
const NON_BRACKET_TRAILING_RE = /[.,;:!?'">]+$/;

// issue 72: naivné orezanie CELEJ triedy `)]}...` bralo aj zátvorku, ktorá je
// SÚČASŤOU samotnej URL (napr. `https://shop.example.com/a_(b)` — reálne
// existujúce URL tvary s zátvorkou v ceste), nie len obalujúceho textu
// ("(pozri https://...)"). Preto sa zatváracia zátvorka orezáva LEN keď je
// vo vnútri kandidátnej URL NEVYVÁŽENÁ (viac zatváracích než otváracích —
// bola prevzatá z obalujúceho textu, nepatrí URL), nikdy keď je vyvážená.
const BRACKET_PAIRS: readonly (readonly [open: string, close: string])[] = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
];

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (const char of haystack) {
    if (char === needle) count += 1;
  }
  return count;
}

// Iteruje, kým sa niečo mení — pokrýva zmiešané/opakované konce ako `(b).`
// alebo `x).`: najprv orež nezátvorkovú interpunkciu, potom over/orež
// nevyváženú zátvorku, opakuj.
function trimTrailingPunctuation(candidate: string): string {
  let url = candidate;
  let changed = true;
  while (changed) {
    changed = false;

    const withoutTrailingPunctuation = url.replace(NON_BRACKET_TRAILING_RE, "");
    if (withoutTrailingPunctuation !== url) {
      url = withoutTrailingPunctuation;
      changed = true;
      continue;
    }

    for (const [open, close] of BRACKET_PAIRS) {
      if (!url.endsWith(close)) continue;
      const isUnbalanced = countOccurrences(url, close) > countOccurrences(url, open);
      if (isUnbalanced) {
        url = url.slice(0, -1);
        changed = true;
        break;
      }
    }
  }
  return url;
}

export function extractSupplierLink(internalNote: string | null): SupplierLink {
  const raw = (internalNote ?? "").trim();
  if (raw === "") return { url: null, note: null };
  const match = URL_RE.exec(raw);
  if (match === null) return { url: null, note: raw };
  const url = trimTrailingPunctuation(match[0]);
  return { url, note: raw };
}
