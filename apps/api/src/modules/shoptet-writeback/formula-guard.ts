/**
 * CSV/spreadsheet formula-injection guard (issue 153). A cell beginning with
 * one of these four characters is interpreted as a LIVE FORMULA by Excel/
 * LibreOffice/Google Sheets when the CSV is opened — real forestshop values
 * (URLs, product/pairing codes) never start with them. Same four characters
 * as the sibling `parovanie_produktov` app's `_FORMULA_LEAD`/`_csv_safe`
 * (`webreview/app.py`) — this is a direct behavioural port, see issue 153's
 * design comment for why the reference app's OWN URL fields never needed a
 * separate reject (the `^https?:\/\//` shape rule already excludes them) and
 * where it DOES add one (its supplier-name field, which has no other shape
 * rule).
 */
export const FORMULA_LEAD_CHARS = ["=", "+", "-", "@"] as const;

export function startsWithFormulaChar(value: string): boolean {
  const first = value.slice(0, 1);
  return (FORMULA_LEAD_CHARS as readonly string[]).includes(first);
}

/**
 * Neutralizes a formula-leading CSV cell value — prefixes a single quote so
 * spreadsheet software renders it as inert text instead of evaluating it as
 * a formula (identical mechanism to the reference app's `_csv_safe`).
 * Applied at the CSV SINK (`csv.ts`) to EVERY emitted cell, independent of
 * whatever upstream validation already did — belt-and-braces, since `code`/
 * `pairCode` come from the Shoptet catalog import (`variants` table), not
 * from a form validated anywhere in this app.
 */
export function csvSafe(value: string): string {
  return startsWithFormulaChar(value) ? `'${value}` : value;
}
