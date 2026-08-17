import type { NedostupneOrderRow } from "./nedostupneApi.js";

// issue 443: šéf chce v hlavičke skupiny produktu na "Nedostupné tovary"
// vidieť CELKOVÝ počet kusov naprieč objednávkami — nie po jednom kuse v
// každej objednávke, ale súčet ("nie 1 ks v jednej a 1 ks v druhej, ale nech
// tam svieti 2 ks toho produktu"). Rovnaký klientský vzor ako súčtový odznak
// `Σ N` na "Na objednanie" (`ordersSummary.ts`'s `formatVariantTotalChip`),
// žiadna API zmena — `quantity` už je v odpovedi.

/** Súčet kusov produktu naprieč VŠETKÝMI objednávkami skupiny. */
export function computeNedostupneGroupTotalPieces(orders: readonly Pick<NedostupneOrderRow, "quantity">[]): number {
  return orders.reduce((sum, order) => sum + order.quantity, 0);
}

/**
 * Odznak "Σ N" do hlavičky skupiny — rovnaký vizuál (`.qty-total-chip`) ako
 * "Na objednanie". Zobrazí sa LEN keď skupina má ≥2 objednávky; jediná
 * objednávka by len zopakovala množstvo svojho riadku (rovnaký zámer ako
 * `formatVariantTotalChip`'s `lineCount < 2`).
 */
export function formatNedostupneTotalChip(
  orders: readonly Pick<NedostupneOrderRow, "quantity">[],
): { readonly text: string; readonly title: string } | null {
  if (orders.length < 2) return null;
  const total = computeNedostupneGroupTotalPieces(orders);
  return {
    text: `Σ ${String(total)}`,
    title: `Spolu vo všetkých objednávkach: ${String(total)} ks`,
  };
}
