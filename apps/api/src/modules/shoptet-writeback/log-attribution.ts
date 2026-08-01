/**
 * Attribúcia výsledku z Shoptet Import-Logu — čistá logika (žiadny prehliadač
 * tu), portovaná zo sesterského projektu `parovanie_produktov`'s
 * `src/parovanie/shoptet_import.py`, ktorý ju má overenú naživo cez viacero
 * produkčných incidentov (#23, #196, #257 tam). Prečo je to vôbec potrebné:
 * Shoptet nevracia žiadne API volanie s výsledkom — jediný spôsob, ako
 * zistiť, čo sa stalo, je prečítať si TABUĽKU "Log" na
 * `/admin/import-produktov/log/`, ktorá zobrazuje VŠETKY importy (aj cudzie,
 * aj staršie) NAJNOVŠIE HORE. Bez baseline+expected-rows atribúcie by čítanie
 * ľahko priradilo CUDZÍ alebo STARŠÍ riadok tomuto behu.
 */

export interface ParsedImportLog {
  readonly raw: string;
  readonly processed: number | null;
  readonly updated: number | null;
  readonly failed: number | null;
  readonly errorDetail: string | null;
}

function numAfter(low: string, ...patterns: RegExp[]): number | null {
  for (const re of patterns) {
    const m = re.exec(low);
    if (m?.[1] !== undefined) return Number.parseInt(m[1], 10);
  }
  return null;
}

/**
 * Vytiahne processed/updated/failed zo Shoptet výsledkového riadku
 * ('Spracované: 1. Zlyhanie variantov: 1.' / česky 'Zpracováno: 1. Upraveno: 1.').
 * `failed` uprednostní explicitné 'Zlyhanie …: N' pred všeobecnou prózou
 * 'skončil s chybou' (tá nenesie žiadne číslo) — inak by próza "chybou"
 * omylom zachytila číslo za sebou, ktoré patrí 'processed'.
 */
export function parseImportLog(text: string | null | undefined): ParsedImportLog {
  const raw = text ?? "";
  const low = raw.toLowerCase();
  const processed = numAfter(low, /z?pracov\w*[^0-9]{0,40}?(\d+)/);
  const failed = numAfter(low, /zlyhan\w*[^0-9]{0,40}?(\d+)/, /ch[ýy]b\w*\s*:\s*(\d+)/);
  const updated = numAfter(low, /uprav\w*[^0-9]{0,40}?(\d+)/);
  const errorDetail = processed === null && low.includes("chyba") ? raw.trim() || null : null;
  return { raw, processed, updated, failed, errorDetail };
}

const RESULT_ROW_RE = /spracov|zpracov|uprav|zlyhan|chyba|riadku/i;
const ENTRY_ID_RE = /^\s*#(\d+)/;

/** Shoptetovo vlastné rastúce číslo Log riadku ('#12689 …' → 12689), alebo
 * `null`, keď riadok žiadne nenesie (staršie/iné zobrazenie — volajúci to
 * musí degradovať, nikdy nespadnúť). ZAKOTVENÉ na začiatku textu — '#42'
 * niekde vnútri (číslo objednávky, kód) nie je entry id. */
export function logEntryId(text: string | null | undefined): number | null {
  const m = ENTRY_ID_RE.exec(text ?? "");
  return m?.[1] !== undefined ? Number.parseInt(m[1], 10) : null;
}

/** Videl tento čítací pokus VÔBEC log tabuľku (aspoň jeden riadok tvarom
 * pripomínajúci skutočný import-log záznam)? Hlavičkový riadok/prázdna
 * stránka sa nepočíta. */
export function hasLogEntries(rowTexts: readonly (string | null | undefined)[]): boolean {
  return rowTexts.some((t) => RESULT_ROW_RE.test(t ?? ""));
}

/** Stabilný kľúč jedného riadku Logu na "settle" kontrolu v čítacom pollingu
 * (`playwright-import.ts`'s `pollForResult`): Shoptetovo '#id', keď ho
 * riadok nesie, inak surový text ako záloha (ten vie tikať kvôli
 * relatívnemu času, ale to je jediná dostupná možnosť pri staršom/inom
 * zobrazení bez '#id' — rovnaký kompromis ako `parovanie_produktov`'s
 * `_entry_key`). */
export function entryKey(row: string): string {
  const id = logEntryId(row);
  return id !== null ? String(id) : row;
}

/** Log riadky napísané PO `baseline` (najvrchnejší riadok zachytený PRED
 * odoslaním importu), najnovšie prvé. Používa Shoptetovo entry id, keď ho
 * nesú obe strany; inak sa spolieha na poradie v tabuľke (Log sa vykresľuje
 * najnovšie navrchu, takže všetko od `baseline` nadol je staršie). */
function newEntries(entries: readonly string[], baseline: string | null): string[] {
  const baseId = logEntryId(baseline);
  const out: string[] = [];
  for (const t of entries) {
    if (baseline !== null && t === baseline) break;
    const tid = logEntryId(t);
    if (baseId !== null && tid !== null && tid <= baseId) break;
    out.push(t);
  }
  return out;
}

export interface PickResultRowOptions {
  readonly baseline: string | null;
  readonly expectedRows: number | null;
}

/**
 * Vyberie riadok Logu, ktorý zodpovedá PRÁVE odoslanému behu — nikdy hádanie.
 * Vracia `null` ("naše/nečitateľné zatiaľ" — volajúci musí opakovať čítanie,
 * a nakoniec to nahlásiť ako nečitateľný výsledok), keď: žiadny riadok
 * nevyzerá ako log-entry, nič nové sa neobjavilo od baseline, alebo nové
 * riadky nejde jednoznačne priradiť.
 */
export function pickResultRow(
  rowTexts: readonly (string | null | undefined)[],
  options: PickResultRowOptions,
): string | null {
  const { baseline, expectedRows } = options;
  const entries = rowTexts.filter((t): t is string => RESULT_ROW_RE.test(t ?? ""));
  if (entries.length === 0) return null;
  if (expectedRows !== null && baseline === null) {
    // Baseline sa nedal zachytiť (stránka Logu nečitateľná/nevykreslená) —
    // KAŽDÝ viditeľný riadok by bol kandidát, aj dni starý so zhodným počtom.
    // Nič sa tu nedá priradiť: fail-closed.
    return null;
  }
  const candidates = newEntries(entries, baseline);
  if (candidates.length === 0) return null;
  if (expectedRows === null) return candidates[0] ?? null;
  const matches = candidates.filter((c) => parseImportLog(c).processed === expectedRows);
  if (matches.length === 1) return matches[0] ?? null;
  if (matches.length > 1) return null; // dva rovnako veľké importy — nejednoznačné
  if (candidates.length === 1 && parseImportLog(candidates[0]).errorDetail !== null) {
    // tvrdý abort nenesie žiadne 'Spracované' vôbec; patrí nám, len keď je
    // JEDINÝ nový riadok (nič iné ho nemohlo napísať)
    return candidates[0] ?? null;
  }
  return null;
}

/** Exit-code štýl verdikt z už rozobraného výsledku — nikdy nehlási zlyhaný
 * alebo nečitateľný import ako úspech. */
/**
 * `parsed.failed` je `null` len keď text nemá ŽIADNU zmienku o zlyhaní
 * (ani explicitné "Zlyhanie … N", ani "chyb(y)/chýb: N") — na reálnom
 * Shoptet výstupe to nastáva PRÁVE pri úplne čistom importe (žiadna
 * "Zlyhanie variantov: 0." fráza sa vôbec nevypíše, keď nie je čo hlásiť;
 * pozorované naživo pri návrhu #122). `null` sa preto úmyselne správa ako
 * "žiadne zlyhanie" (rovnaká sémantika ako sesterský `chunk_outcome`'s
 * `parsed.get("failed") or 0` — falošné aj `None` aj `0`), NIE ako
 * "nečitateľné" — tú vetvu už pokrýva `processed === null` vyššie.
 */
export function resultExitCode(parsed: ParsedImportLog | null | undefined): number {
  if (!parsed || parsed.processed === null) return 2;
  if (parsed.failed) return 2;
  return 0;
}
