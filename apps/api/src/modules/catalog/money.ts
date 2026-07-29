// Sumy zo Shoptetu sú reťazce s desatinnou ČIARKOU ("67,00"). Do databázy idú ako
// `numeric` (drizzle ich drží ako reťazec), takže sa nikde nedotknú `number` a
// nemôžu stratiť presnosť. Mena je vždy vedľa sumy — `variant.currency` a CHECK
// `variant_money_needs_currency_ck` (Task 1) to vynucujú aj v databáze.

const DECIMAL_RE = /^-?\d+(?:[.,]\d+)?$/;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/;

/** Vráti hodnotu vhodnú pre `numeric` stĺpec, alebo null (prázdne aj nečitateľné). */
export function parseDecimalComma(raw: string): string | null {
  const cleaned = raw.replace(/[\s\u00a0]/g, "");
  if (cleaned === "") return null;
  if (!DECIMAL_RE.test(cleaned)) return null;
  return cleaned.replace(",", ".");
}

/** Vráti dátum v tvare YYYY-MM-DD pre `date` stĺpec, alebo null. */
export function parseDate(raw: string): string | null {
  const match = DATE_RE.exec(raw.trim());
  return match?.[1] ?? null;
}
