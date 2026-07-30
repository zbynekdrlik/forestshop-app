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

export function extractSupplierLink(internalNote: string | null): SupplierLink {
  const raw = (internalNote ?? "").trim();
  if (raw === "") return { url: null, note: null };
  const match = URL_RE.exec(raw);
  if (match === null) return { url: null, note: raw };
  return { url: match[0], note: raw };
}
