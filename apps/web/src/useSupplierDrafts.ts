import { useCallback, useEffect, useState } from "react";
import type { SupplierOpenOrders } from "./ordersApi.js";

// issue 151 — vyňaté z `OrdersSection.tsx`, rovnaký princíp ako existujúce
// `useDirtyEditorLineIds.ts` (issue 149), tentokrát nesúci SAMOTNÝ ROZPÍSANÝ
// TEXT namiesto len ľahkého boolean signálu.
//
// Prečo to nestačí držať lokálne v `OrderLineRow` (`isSupplierDirty` ref by
// bola prirodzená prvá voľba, presne ako `isCommentDirty` pri komentári):
// priradenie dodávateľa platí pre CELÝ PRODUKT (`supplier-assignment.ts`),
// takže po uložení sa `effectiveSupplier` (teda aj SKUPINA riadku,
// `OrdersSection.tsx`'s `SupplierOrderGroup key={group.supplier}`) zmení pre
// KAŽDÝ riadok toho istého produktu — nielen ten, čo reálne uložil. Zmena
// skupiny znamená, že `OrderLineRow` danej inštancie sa NEPREKRESLÍ so
// zmenenými props — ODMONTUJE sa (starý strom pod starou skupinou) a NOVÁ
// inštancia sa NAMONTUJE pod novou skupinou (empiricky overené priamym
// behom, nie len čítaním kódu — `document.contains()` na starý DOM uzol
// vrátil `false`). Žiadny lokálny `useState`/`useEffect`/`ref` neprežije
// tento prechod — musí žiť tu, na úrovni `OrdersSection`, ktorá sa
// presúvaním riadkov medzi skupinami NIKDY neodmontuje.
//
// `OrderLineRow` odvodí zobrazovanú hodnotu ako `pendingDraft ??
// (line.manualSupplierOverride ?? "")` — pri remounte tak automaticky
// dostane SPRÁVNU, ešte neuloženú hodnotu z tejto mapy namiesto čerstvo
// inicializovaného stavu.
export interface SupplierDraftsApi {
  readonly draftByLineId: ReadonlyMap<string, string>;
  readonly setDraft: (lineId: string, value: string) => void;
}

// `groups` je `OrdersSection.tsx`'s `suppliers` stav — zosúladenie beží
// SAMO po KAŽDEJ jeho zmene (teda po KAŽDOM refetchi), takže volajúci
// nemusí na nič zvlášť myslieť. Čistí záznam, keď potvrdená
// `manualSupplierOverride` (zo servera) už zodpovedá rozpísanému konceptu
// (uloženie sa potvrdilo), a záznamy, ktorých riadok medzičasom vôbec
// zmizol zo zoznamu otvorených objednávok (vybavené/zmenený stav). Bez
// tohto by mapa raz uložený koncept držala NAVŽDY a blokovala by
// akúkoľvek budúcu legitímnu externú zmenu (napr. kolegom).
export function useSupplierDrafts(groups: readonly SupplierOpenOrders[]): SupplierDraftsApi {
  const [draftByLineId, setDraftByLineId] = useState<ReadonlyMap<string, string>>(new Map());

  const setDraft = useCallback((lineId: string, value: string) => {
    setDraftByLineId((current) => {
      const next = new Map(current);
      next.set(lineId, value);
      return next;
    });
  }, []);

  useEffect(() => {
    setDraftByLineId((current) => {
      if (current.size === 0) return current;
      const overrideByLineId = new Map(
        groups.flatMap((group) => group.lines).map((line) => [line.lineId, line.manualSupplierOverride ?? ""]),
      );
      let changed = false;
      const next = new Map(current);
      for (const [lineId, draft] of current) {
        const confirmed = overrideByLineId.get(lineId);
        // Code review (post-merge): toto porovnáva HODNOTU, nie totožnosť
        // zápisu — nevie rozlíšiť "toto je MOJE uloženie, čo sa práve
        // potvrdilo" od "niekto iný náhodou nastavil rovnaký text na tomto
        // produkte inou cestou". V praxi je výsledok vizuálne identický v
        // oboch prípadoch (koncept == potvrdená hodnota), takže to nevadí.
        if (confirmed === undefined || draft.trim() === confirmed) {
          next.delete(lineId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [groups]);

  return { draftByLineId, setDraft };
}
