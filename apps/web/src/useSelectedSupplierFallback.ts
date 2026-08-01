import { useEffect } from "react";
import type { SupplierOpenOrders } from "./ordersApi.js";

// issue 148 — priamy náprotivok starej appky's fallback (`app.js:2677-2680`):
// keď je dodávateľ vybraný z PREDCHÁDZAJÚCEJ relácie/dňa (localStorage) a
// medzi PRÁVE načítanými skupinami už vôbec nefiguruje, výber spadne späť
// na "Všetci" — namiesto toho, aby zobrazil prázdny zoznam s aktívnym
// chipom, ktorý nikde nie je. `suppliers.length === 0` sa zámerne
// VYNECHÁVA (rovnako ako stará appka) — prechodné zlyhanie fetchu nesmie
// zahodiť platný výber.
//
// Vyňaté z `OrdersSection.tsx` (issue 151 — uvoľnenie miesta pod eslint
// `max-lines` pre `useSupplierDrafts`, rovnaký dôvod ako existujúce hook-
// extrakcie, `.claude/rules/frontend-design.md`), BEZ zmeny správania.
export function useSelectedSupplierFallback(
  loaded: boolean,
  suppliers: readonly SupplierOpenOrders[],
  selectedSupplier: string | null,
  selectSupplier: (next: string | null) => void,
): void {
  useEffect(() => {
    if (!loaded || selectedSupplier === null || suppliers.length === 0) return;
    if (!suppliers.some((group) => group.supplier === selectedSupplier)) {
      selectSupplier(null);
    }
  }, [loaded, suppliers, selectedSupplier, selectSupplier]);
}
