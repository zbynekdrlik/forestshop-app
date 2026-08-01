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
//
// Code review (PR 154): `dirtyEditorLineIds` je NOVÝ `Set` pri KAŽDEJ zmene
// (immutable update vyššie), takže KAŽDÝ `SupplierOrderGroup`/`OrderLineRow`
// na celej obrazovke sa prekreslí pri otvorení/zavretí ktoréhokoľvek JEDNÉHO
// riadku — nič v tomto strome dnes nie je `React.memo`. Pri dnešných
// desiatkach riadkov ("Na objednanie") je to zanedbateľné; ak by objem
// objednávok narástol natoľko, že by to bolo merateľne pomalé, riešenie je
// `React.memo` na `SupplierOrderGroup`/`OrderLineRow` s vlastným
// porovnávačom (len `dirtyEditorLineIds.has(line.lineId)`, nie celý set) —
// pozri aj `OrderLineRow.tsx`'s komentár pri `commentDirtyNow` predtým, než
// taký `React.memo` krok urobíš.
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
