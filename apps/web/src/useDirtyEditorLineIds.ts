import { useCallback, useState } from "react";

// issue 149 — vyňaté z `OrdersSection.tsx` (rovnaký dôvod ako existujúce hook-
// extrakcie `useSupplierEmailEditing.ts`/`useSupplierMailActions.ts`,
// `.claude/rules/frontend-design.md`): riadky, ktoré PRÁVE TERAZ držia
// rozpísanú/otvorenú úpravu (odkaz na dodávateľa, ručné priradenie mena
// dodávateľa, komentár — `OrderLineRow.tsx` hlási zmenu cez `setActive`).
// Nesie len ĽAHKÝ boolean signál per `lineId`, NIE samotný rozpísaný text —
// ten ostáva výlučne vnútri `OrderLineRow`. Filter "skryť vybavené"
// (`SupplierOrderGroup.tsx`'s `visibleLines`) aj `OrdersSection.tsx`'s
// `visibleLinesCount` použijú výsledný set ako VÝNIMKU: vybavený riadok s
// otvorenou úpravou ostáva viditeľný, kým sa úprava nezavrie/neuloží.
export function useDirtyEditorLineIds(): {
  readonly dirtyEditorLineIds: ReadonlySet<string>;
  readonly setActive: (lineId: string, active: boolean) => void;
} {
  const [dirtyEditorLineIds, setDirtyEditorLineIds] = useState<ReadonlySet<string>>(new Set());
  const setActive = useCallback((lineId: string, active: boolean) => {
    setDirtyEditorLineIds((current) => {
      const alreadyActive = current.has(lineId);
      if (active === alreadyActive) return current;
      const next = new Set(current);
      if (active) next.add(lineId);
      else next.delete(lineId);
      return next;
    });
  }, []);
  return { dirtyEditorLineIds, setActive };
}
