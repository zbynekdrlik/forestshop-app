// `availabilityInStock` a `availabilityOutOfStock` sú v Shoptete VOĽNÝ TEXT, nie
// číselník — v produkčnom exporte sa vyskytujú okrem iného "Skladom", "Vypredané",
// "Predaj výrobku skončil", "Není skladem", "Momentálne nedostupné", "Dodanie 1-3 dni".
// Pôvodný text sa preto ukladá NEZMENENÝ a stav sa z neho len ODVODZUJE. Keď Shoptet
// pridá nový text, katalóg ho nestratí — nanajvýš ho zaradí ako `sellable` a doplní
// sa sem nové pravidlo aj s testom.

export type VariantState = "sellable" | "out_of_stock" | "discontinued";

/** Viditeľnosti, pri ktorých produkt v e-shope nikto bežne nekúpi. */
export const HIDDEN_VISIBILITIES: readonly string[] = [
  "hidden",
  "blocked",
  "cashDeskOnly",
  "blockUnregistered",
];

const DISCONTINUED_MARKERS: readonly string[] = ["skon"]; // "Predaj výrobku skončil"
const OUT_OF_STOCK_MARKERS: readonly string[] = [
  "vypredan",
  "nedostupn",
  "není skladem",
  "neni skladem",
];

export interface AvailabilityInput {
  readonly stock: number;
  readonly inStockText: string;
  readonly outOfStockText: string;
}

export function effectiveAvailabilityText(input: AvailabilityInput): string {
  const primary = input.stock > 0 ? input.inStockText : input.outOfStockText;
  const fallback = input.stock > 0 ? input.outOfStockText : input.inStockText;
  return primary !== "" ? primary : fallback;
}

export function deriveVariantState(
  input: AvailabilityInput & {
    readonly productVisibility: string;
    // Per-variantný prepínač, NEZÁVISLÝ od `productVisibility` (ten je na
    // úrovni celého produktu) — "0" znamená, že Shoptet vypol PRÁVE TENTO
    // variant jednotlivo (napr. jedna veľkosť z radu). Skutočné hodnoty v
    // exporte: "0", "1", alebo prázdny reťazec (~2 700 jednovariantných
    // produktov ho často vôbec nevypĺňa) — prázdny sa berie ako viditeľný,
    // nikdy ako vypnutý.
    readonly variantVisibility: string;
  },
): VariantState {
  if (HIDDEN_VISIBILITIES.includes(input.productVisibility)) return "discontinued";

  const text = effectiveAvailabilityText(input).toLowerCase();
  if (DISCONTINUED_MARKERS.some((marker) => text.includes(marker))) return "discontinued";
  if (OUT_OF_STOCK_MARKERS.some((marker) => text.includes(marker))) return "out_of_stock";
  // Vypnutý jednotlivý variant sa NIKDY nezobrazí ako predajný — no nesmie
  // prebiť silnejší signál vyššie (text/produktová viditeľnosť hovoriaca
  // "discontinued"), preto je táto kontrola AŽ TU, pred predvoleným "sellable".
  if (input.variantVisibility === "0") return "out_of_stock";
  // Prázdny text nesie nulovú informáciu (týka sa väčšiny riadkov exportu) — až
  // vtedy, a len vtedy, rozhoduje sklad.
  if (text === "") return input.stock > 0 ? "sellable" : "out_of_stock";
  return "sellable";
}
