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
  // Jednotlivo vypnutý variant je `discontinued`, NIE `out_of_stock` (issue 219,
  // druhá vlna). "0" znamená, že majiteľ TÚ KONKRÉTNU veľkosť v Shoptete vypol —
  // je to vedomé „nepredávať", presne ako `detailOnly`, nie „došiel tovar".
  // Rozdiel je nosný: `out_of_stock` je vstupom do automatizácie
  // „Vypredané → Skladom", takže pri starom zaradení sa 233 vypnutých variantov
  // stalo kandidátmi na zapnutie — a zápis textu dostupnosti by ich aj tak
  // nezapol (vypnutie je iné pole), takže by to bolo prepínanie naprázdno na
  // produktoch, ktoré majiteľ vedome vypol. Kontrola je PRED textom: vypnutý
  // variant nesmie „prebiť" nič, ale text „Vypredané" ho nesmie stiahnuť späť
  // medzi kandidátov.
  if (input.variantVisibility === "0") return "discontinued";

  const text = effectiveAvailabilityText(input).toLowerCase();
  if (DISCONTINUED_MARKERS.some((marker) => text.includes(marker))) return "discontinued";
  if (OUT_OF_STOCK_MARKERS.some((marker) => text.includes(marker))) return "out_of_stock";
  // Prázdny text NIE JE vypredané a `stock` do stavu nevstupuje vôbec (issue 219).
  // Prázdna dostupnosť znamená, že produkt ju nemá priradenú, takže Shoptet
  // zobrazí PREDVOLENÚ — na tomto e-shope zelené „Skladom" (overené naživo na
  // 10-12106-087, 10-11284-083 a pončo Deerhunter Survivor: všetky vracajú
  // `schema.org/InStock`). Majiteľ navyše skladovú logistiku v Shoptete
  // NEPOUŽÍVA (rozhodnutie 4. 8. 2026) a `negativeAmount = 1` má na všetkých
  // 14 071 riadkoch exportu, takže sa taký produkt kúpi aj pri nulovej zásobe.
  // Zásoba tu preto nesmie nič rozhodovať — inak automatizácia zapína produkty,
  // ktoré sú už dávno v predaji (6 793 takých riadkov).
  return "sellable";
}
