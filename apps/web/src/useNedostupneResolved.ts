import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { NedostupneUnauthorizedError, setNedostupneResolved, type NedostupneList } from "./nedostupneApi.js";

// issue 531: ručné označenie „vyriešené" pri karte produktu — vyčlenené z
// `NedostupneSection.tsx` (eslint `max-lines`), rovnaká „lift do vlastného
// hooku" disciplína ako `useLoadMore`/`useStaleResponseGuard`. Optimistická
// lokálna zmena (checkbox sa prekreslí HNEĎ), pri chybe sa vráti späť — žiadny
// plný reload zoznamu (označenie nemení triedenie ani skladbu kariet, „nič
// ďalšie sa nestane, len sa to označí").
export function useNedostupneResolved(deps: {
  readonly setList: Dispatch<SetStateAction<NedostupneList | null>>;
  readonly setActionError: (message: string) => void;
  readonly onSessionExpired: () => void;
}): {
  readonly resolvedBusy: string;
  readonly toggleResolved: (variantCode: string, resolved: boolean) => void;
  readonly reconcileResolved: (list: NedostupneList) => NedostupneList;
} {
  const { setList, setActionError, onSessionExpired } = deps;
  // Prebiehajúci zápis pre daný variant — checkbox je počas neho `disabled`,
  // aby dvojklik nespustil dva protichodné zápisy.
  const [resolvedBusy, setResolvedBusy] = useState("");
  // issue 535: nevyrovnané optimistické (od)označenia — `variantCode` → želaná
  // hodnota `resolved`. Akciou-spustený `load()` (`saveNote`/`addLink`/…) vráti
  // serverovú snímku odfotenú PRED tým, ako tu prebiehajúci toggle PUT commitol;
  // `reconcileResolved` (volaný v `load().then` pred `setList`) na ňu tieto
  // optimistické hodnoty re-aplikuje, aby ju nezastaraná snímka neprepísala späť.
  // `useStaleResponseGuard` (PR #536) rieši INÚ os (load-vs-load), túto (load-
  // vs-optimistický-zápis) nepokrýva. Ref, nie state — číta ho `.then` mikrotaska
  // a nesmie refirovať `useEffect(load)` (issue 251/254 „latest ref" trieda).
  const pendingResolvedRef = useRef<Map<string, boolean>>(new Map());

  const setGroupResolved = useCallback(
    (variantCode: string, resolved: boolean) => {
      setList((current) => (current === null ? current : { ...current, groups: current.groups.map((g) => (g.variantCode === variantCode ? { ...g, resolved } : g)) }));
    },
    [setList],
  );

  const toggleResolved = useCallback(
    (variantCode: string, resolved: boolean) => {
      setActionError("");
      setResolvedBusy(variantCode);
      // Zaznač želanú hodnotu ešte pred PUT — kým ju server nepotvrdí, drží ju
      // `reconcileResolved` proti zastaranej snímke akciou-spusteného loadu.
      pendingResolvedRef.current.set(variantCode, resolved);
      setGroupResolved(variantCode, resolved);
      setNedostupneResolved(variantCode, resolved)
        .catch((err: unknown) => {
          // Vráť optimistickú zmenu späť — server je zdroj pravdy. Zahoď aj
          // nevyrovnaný záznam, inak by `reconcileResolved` re-aplikoval hodnotu,
          // ktorá sa neuložila.
          pendingResolvedRef.current.delete(variantCode);
          setGroupResolved(variantCode, !resolved);
          if (err instanceof NedostupneUnauthorizedError) {
            onSessionExpired();
            return;
          }
          setActionError(err instanceof Error ? err.message : "Označenie sa nepodarilo uložiť.");
        })
        .finally(() => {
          setResolvedBusy("");
        });
    },
    [setGroupResolved, setActionError, onSessionExpired],
  );

  // issue 535: re-aplikuj nevyrovnané optimistické (od)označenia na serverovú
  // odpoveď loadu. Self-cleaning: keď sa server so želanou hodnotou ZHODUJE,
  // zápis je premietnutý → záznam sa zmaže (a použije sa server); keď sa
  // NEzhoduje (snímka je zastaraná, predchádza náš zápis) → drží sa optimistická
  // hodnota. Stabilná identita (`useCallback([])`, číta ref) — rovnaký dôvod ako
  // `useStaleResponseGuard`: nesmie rozbiť `load` memoizáciu / refirovať efekt.
  const reconcileResolved = useCallback((list: NedostupneList): NedostupneList => {
    const pending = pendingResolvedRef.current;
    if (pending.size === 0) return list;
    const groups = list.groups.map((g) => {
      const desired = pending.get(g.variantCode);
      if (desired === undefined) return g;
      if (g.resolved === desired) {
        pending.delete(g.variantCode);
        return g;
      }
      return { ...g, resolved: desired };
    });
    return { ...list, groups };
  }, []);

  return { resolvedBusy, toggleResolved, reconcileResolved };
}
