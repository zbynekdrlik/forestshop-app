import { useMemo, useRef } from "react";

// issue 523: zdieľaný "stale-response guard" — vyčlenený z ~16 inline kópií
// naprieč komponentmi (`fetchSeqRef`/`loadSeqRef`/`searchSeq`/… vzor,
// `.claude/rules/frontend-design.md` issue 151/251/254/264). Chráni pred
// pretekmi, keď dve rýchle zmeny filtra/dopytu vystrelia dva fetche naraz:
// keď sa STARŠÍ vráti AŽ PO novom, jeho (už zastaraná) odpoveď NESMIE
// prepísať to, čo najnovší dopyt zobrazil.
//
// Použitie:
//   const guard = useStaleResponseGuard();
//   const load = useCallback(() => {
//     const seq = guard.begin();
//     fetchX(...)
//       .then((r) => { if (!guard.isLatest(seq)) return; /* aplikuj r */ })
//       .catch((e) => { if (!guard.isLatest(seq)) return; /* obsluž e */ });
//   }, [...]);
//
// `cancel()` je pre dialóg/panel, ktorý sa smie zavrieť PRED doletením
// odpovede — zahodí prebiehajúci fetch bez začatia nového.
//
// Komponent s DVOMA nezávislými fetchmi (napr. vyhľadávanie + detail) zavolá
// hook DVAKRÁT — každý guard má vlastný sekvenčný čítač.
export interface StaleResponseGuard {
  /**
   * Začni nový fetch: zvýš sekvenčné číslo, vráť ho a zároveň znehodnoť každý
   * skôr začatý (ešte prebiehajúci) fetch tohto guardu.
   */
  readonly begin: () => number;
  /** `true` práve vtedy, keď `seq` je stále NAJNOVŠÍ začatý fetch (jeho odpoveď sa smie uplatniť). */
  readonly isLatest: (seq: number) => boolean;
  /** Znehodnoť každý prebiehajúci fetch bez začatia nového (napr. pri zavretí dialógu). */
  readonly cancel: () => void;
}

export function useStaleResponseGuard(): StaleResponseGuard {
  const seqRef = useRef(0);
  // `useMemo([])` drží objekt AJ jeho metódy stabilné počas celej životnosti
  // komponentu — inak by zmena ich identity pri každom rendere rozbila
  // `useCallback` memoizáciu volajúcich (`.claude/rules/frontend-design.md`
  // issue 147). `seqRef` je stabilné, takže closures nikdy nezastarajú.
  return useMemo(
    () => ({
      begin: (): number => ++seqRef.current,
      isLatest: (seq: number): boolean => seqRef.current === seq,
      cancel: (): void => {
        seqRef.current += 1;
      },
    }),
    [],
  );
}
