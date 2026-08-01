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
};
