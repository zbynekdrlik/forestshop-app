// issue 595: argument `--from YYYY-MM-DD` CLI `orders-backfill-open` — vyčlenené
// z CLI (ktoré má vedľajšie účinky už pri importe), aby šlo unit-testovať.

export const BACKFILL_OPEN_USAGE = "Použitie: orders-backfill-open --from YYYY-MM-DD";

/** `--from YYYY-MM-DD` → polnoc UTC toho dňa (rovnaká konvencia ako `computeImportWindow`). */
export function parseBackfillFromArg(argv: readonly string[]): Date {
  const index = argv.indexOf("--from");
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Chýba alebo je chybný --from. ${BACKFILL_OPEN_USAGE}`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  // `Date` neexistujúci deň "opraví" (2025-02-30 → 2. 3.) — taký vstup odmietni.
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Neplatný dátum v --from: ${value}. ${BACKFILL_OPEN_USAGE}`);
  }
  return date;
}
