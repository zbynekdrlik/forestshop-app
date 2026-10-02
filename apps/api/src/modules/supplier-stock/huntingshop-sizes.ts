// huntingshop.eu per-veľkosť dostupnosť — issue 585. ČISTÉ funkcie nad HTML.
//
// Produktová stránka huntingshop.eu (Nette) nesie DVA výbery veľkostí:
//   - výber formulára „Kúpiť" (pridanie do košíka) — LEN veľkosti, ktoré sa dajú
//     kúpiť = dodávateľ ich má skladom;
//   - výber formulára „Strážny pes" (upozornenie, keď bude tovar skladom) —
//     VŠETKY veľkosti produktu, aj vypredané. NIKDY to nie je dostupnosť.
// Oba sú ukotvené na jedinečné id prvkov (overené naživo 2. 10. 2026 na ~50
// produktoch: id sú na stránke vždy najviac raz). Pozor: to isté id formulára
// Kúpiť sa objavuje aj v inline JS (`getElementById(...)`) na KAŽDEJ stránke —
// preto sa hľadá výhradne ako atribút otváracej značky `<select>`/`<form>`.
//
// Štítok pri cene („Skladom viac ako 3 kusy") sa pre viacveľkostný produkt
// NEČÍTA — vykreslí sa rovnako pre každý `?variantId` (overené na veľkosti 43
// produktu 8954, ktorú kúpiť nejde).
//
// Výsledok (`readHuntingshopSizes`):
//   - `sizes`: veľkosť vo výbere Kúpiť → `available`; veľkosť LEN vo výbere
//     Strážny pes → `unavailable`. Naša veľkosť, ktorú stránka vôbec nenesie,
//     sa nespáruje (`matchSizeLabel`) → `unknown` v `buildSizeStockRows`.
//   - formulár Kúpiť na stránke VÔBEC nie je (úplne vypredaný produkt, štítok
//     „Nie je skladom") a Strážny pes nesie veľkosti → všetky `unavailable`.
//   - `none`: žiadny výber veľkostí (jednoveľkostný produkt) → plošný riadok
//     ako doteraz (TEXT pravidlo `huntingshopDetailBadges`).
//   - `error`: štruktúra, ktorej nerozumieme (formulár Kúpiť bez výberu, hoci
//     Strážny pes veľkosti má; výber Kúpiť bez čitateľnej možnosti; veľkosť v
//     Kúpiť, ktorú Strážny pes nepozná; viac výberov naraz) → beh zapíše
//     chybový riadok (`ok=false`), nikdy plošné „skladom".

const CART_FORM_RE = /<form\b[^>]*\bid="frm-addToCart-form"[^>]*>/gi;
const CART_SELECT_RE = /<select\b[^>]*\bid="frm-addToCart-form-variant_id"[^>]*>([\s\S]*?)<\/select>/gi;
const WATCHDOG_SELECT_RE = /<select\b[^>]*\bid="frm-watchDogForm-form-variantIds"[^>]*>([\s\S]*?)<\/select>/gi;
const OPTION_RE = /<option\b[^>]*>([\s\S]*?)<\/option>/gi;

/** Jedna veľkosť dodávateľa (štruktúrne zhodná so `SizeAvailability` v `parse.ts`). */
interface HuntingshopSize {
  readonly sizeLabel: string;
  readonly availability: "available" | "unavailable";
}

export type HuntingshopSizeRead =
  | { readonly kind: "sizes"; readonly sizes: readonly HuntingshopSize[] }
  | { readonly kind: "none" }
  | { readonly kind: "error"; readonly reason: string };

function optionLabels(selectBody: string): string[] {
  return [...selectBody.matchAll(OPTION_RE)]
    .map(([, raw]) => (raw ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim())
    .filter((label) => label !== "");
}

export function readHuntingshopSizes(html: string): HuntingshopSizeRead {
  const cartForms = [...html.matchAll(CART_FORM_RE)].length;
  const cartSelects = [...html.matchAll(CART_SELECT_RE)];
  const watchdogSelects = [...html.matchAll(WATCHDOG_SELECT_RE)];
  if (cartForms > 1 || cartSelects.length > 1 || watchdogSelects.length > 1) {
    return {
      kind: "error",
      reason: `huntingshop.eu: nejednoznačná stránka (formulárov Kúpiť ${cartForms}, výberov Kúpiť ${cartSelects.length}, výberov Strážny pes ${watchdogSelects.length})`,
    };
  }
  const watchdog = watchdogSelects[0] === undefined ? null : optionLabels(watchdogSelects[0][1] ?? "");
  const cartSelect = cartSelects[0];

  if (cartSelect === undefined) {
    if (watchdog === null || watchdog.length === 0) return { kind: "none" };
    if (cartForms === 0) {
      // Úplne vypredaný produkt: kúpiť nejde nič, Strážny pes ponúka všetky veľkosti.
      return { kind: "sizes", sizes: watchdog.map((sizeLabel) => ({ sizeLabel, availability: "unavailable" })) };
    }
    return {
      kind: "error",
      reason: "huntingshop.eu: formulár Kúpiť je bez výberu veľkosti, hoci Strážny pes veľkosti má (zmenená štruktúra stránky)",
    };
  }

  const cart = optionLabels(cartSelect[1] ?? "");
  if (cart.length === 0) {
    return { kind: "error", reason: "huntingshop.eu: výber veľkosti vo formulári Kúpiť nemá čitateľnú možnosť" };
  }
  if (watchdog === null) {
    return { kind: "sizes", sizes: cart.map((sizeLabel) => ({ sizeLabel, availability: "available" })) };
  }
  const unknownToWatchdog = cart.filter((label) => !watchdog.includes(label));
  if (unknownToWatchdog.length > 0) {
    return {
      kind: "error",
      reason: `huntingshop.eu: veľkosť vo formulári Kúpiť chýba v zozname Strážneho psa (${unknownToWatchdog.join(", ")})`,
    };
  }
  return {
    kind: "sizes",
    sizes: watchdog.map((sizeLabel) => ({
      sizeLabel,
      availability: cart.includes(sizeLabel) ? "available" : "unavailable",
    })),
  };
}

/** `SIZE_AVAILABILITY_RULES.read` — zoznam veľkostí, prázdny pri `none`/`error`. */
export function huntingshopSizeList(html: string): readonly HuntingshopSize[] {
  const read = readHuntingshopSizes(html);
  return read.kind === "sizes" ? read.sizes : [];
}

/** `SIZE_AVAILABILITY_RULES.structureError` — dôvod, prečo stránke nerozumieme, alebo `null`. */
export function huntingshopStructureError(html: string): string | null {
  const read = readHuntingshopSizes(html);
  return read.kind === "error" ? read.reason : null;
}
