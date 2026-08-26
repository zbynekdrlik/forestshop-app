import type { OrderLine } from "./ordersApi.js";

// issue 60: `objednane` je VÝCHODISKOVÝ stav riadku (pred tým, než sa
// čokoľvek stane), NIE potvrdenie, že manažér objednal — preto sa nazýva
// "Nevybavené", nie "Objednané" (to slovo teraz patrí VÝLUČNE odškrtávaciemu
// políčku v tomto riadku, `OrderLine["ordered"]`, aby appka nemala na jednej
// obrazovke tri rôzne veci s tým istým názvom).
//
// issue 161: vyňaté z `OrderLineRow.tsx` do vlastného modulu — `<select>`
// nahradili 4 tlačidlá (`OrderLineStateButtons.tsx`), ktoré tento zoznam
// potrebujú TIEŽ; `OrderLineRow.tsx` sám importuje `OrderLineStateButtons`,
// takže zdieľaná hodnota nesmie žiť ani v jednom z nich (cyklický import).
export const STATE_LABELS: Record<OrderLine["state"], string> = {
  objednane: "Nevybavené",
  caka_sa: "Čaká sa",
  skladom: "Skladom",
  nedostupne: "Nedostupné",
  // issue 476: piaty EXKLUZÍVNY stav „Riešiť" (Štěpán) — princíp `nedostupne`,
  // označený riadok sa zobrazí v sekcii Riešiť.
  riesit: "Riešiť",
  // issue 493: šiesty EXKLUZÍVNY stav — interná hodnota `objednane_stav`, label
  // „Objednané" (Štěpán, binding rozhodnutie 5423135473). POZOR: label „Objednané"
  // je zámerne rovnaké slovo ako ✓ checkbox `OrderLine["ordered"]`, ale je to INÁ
  // vec — checkbox = „vybavil som akýmkoľvek spôsobom", tento STAV = stav produktu
  // (`.claude/rules/orders.md` „naming trap"). Interná hodnota preto NESMIE byť
  // `objednane` (to je default „Nevybavené").
  objednane_stav: "Objednané",
};

// issue 476/493: PORADIE tlačidiel v klastri stavov (mockup Štěpán, ROZHODNUTÉ)
// — horný rad Nevybavené · Riešiť · Čaká sa, dolný rad Skladom · Nedostupné ·
// Objednané (`OrderLineStateButtons.tsx` renderuje 3-stĺpcovú mriežku, 6 tlačidiel
// spadne ako 3+3). issue 493: „Objednané" je 6. slot = dolný rad 3. miesto vedľa
// Nedostupné, pod Čaká sa (presne screenshot/binding rozhodnutie Štěpán). Zámerne
// SAMOSTATNÉ pole, nie `Object.keys(STATE_LABELS)` — poradie kľúčov v
// `STATE_LABELS` nesie iný zámer (východiskový enum poradie) a nesmie diktovať
// vizuálne poradie tlačidiel.
export const STATE_DISPLAY_ORDER: readonly OrderLine["state"][] = [
  "objednane",
  "riesit",
  "caka_sa",
  "skladom",
  "nedostupne",
  "objednane_stav",
];

// Kompilačná poistka úplnosti: keby pribudol 6. stav do enumu/`STATE_LABELS`,
// ale zabudol sa doplniť sem, `tsc` padne (nová hodnota by nebola pokrytá
// `STATE_DISPLAY_ORDER`, takže `Exclude<...>` už nie je `never`). Bráni tichému
// „stav existuje, ale jeho tlačidlo sa nikde nevykreslí" (recenzia issue 476).
type _AllStatesInDisplayOrder = Exclude<OrderLine["state"], (typeof STATE_DISPLAY_ORDER)[number]> extends never
  ? true
  : ["CHÝBA stav v STATE_DISPLAY_ORDER", Exclude<OrderLine["state"], (typeof STATE_DISPLAY_ORDER)[number]>];
const _stateDisplayOrderExhaustive: _AllStatesInDisplayOrder = true;
void _stateDisplayOrderExhaustive;
