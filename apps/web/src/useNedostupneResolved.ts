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
  // issue 535: nevyrovnané optimistické (od)označenia — `variantCode` → { želaná
  // hodnota `resolved`, či už PUT commitol (`committed`) }. Akciou-spustený
  // `load()` (`saveNote`/`addLink`/…) vráti serverovú snímku odfotenú PRED tým,
  // ako tu prebiehajúci toggle PUT commitol; `reconcileResolved` (volaný v
  // `load().then` pred `setList`) na ňu tieto optimistické hodnoty re-aplikuje,
  // aby ju nezastaraná snímka neprepísala späť. `useStaleResponseGuard` (PR #536)
  // rieši INÚ os (load-vs-load), túto (load-vs-optimistický-zápis) nepokrýva. Ref,
  // nie state — číta ho `.then` mikrotaska a nesmie refirovať `useEffect(load)`
  // (issue 251/254 „latest ref" trieda).
  const pendingResolvedRef = useRef<Map<string, { readonly desired: boolean; committed: boolean }>>(new Map());

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
      pendingResolvedRef.current.set(variantCode, { desired: resolved, committed: false });
      setGroupResolved(variantCode, resolved);
      setNedostupneResolved(variantCode, resolved)
        .then(() => {
          // Zápis prešiel — server má odteraz našu hodnotu. Označ záznam ako
          // commitnutý (LEN ak ho medzitým neprebil novší toggle iného smeru),
          // aby `reconcileResolved` po commite ešte ochránil zastaranú snímku
          // JEDNÉHO in-flight loadu, no ďalej už serveru ustúpil — inak by
          // záznam maskoval prípadnú súbežnú CUDZIU zmenu donekonečna.
          const entry = pendingResolvedRef.current.get(variantCode);
          if (entry !== undefined && entry.desired === resolved) entry.committed = true;
        })
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
          // Vyčisti busy LEN pre TENTO variant — súbežný toggle iného variantu
          // medzitým prepísal `resolvedBusy` a jeho vlastný PUT ešte beží (jediný
          // skalár, code review issue 535). Rovnaký funkčný-clear vzor ako pri
          // busy-guard pároch inde v appke.
          setResolvedBusy((current) => (current === variantCode ? "" : current));
        });
    },
    [setGroupResolved, setActionError, onSessionExpired],
  );

  // issue 535: re-aplikuj nevyrovnané optimistické (od)označenia na serverovú
  // odpoveď loadu. Self-cleaning s ohraničenou životnosťou:
  //  • server sa so želanou hodnotou ZHODUJE → zápis je premietnutý, záznam zmaž
  //    (a použi server);
  //  • NEZHODUJE sa a PUT ešte NEcommitol → snímka predchádza náš zápis, drž
  //    optimistickú hodnotu (a záznam nechaj);
  //  • NEZHODUJE sa a PUT UŽ commitol → ochráň JEDEN zastaraný in-flight load
  //    (aplikuj želanú hodnotu) a záznam zmaž — ďalší load už serveru ustúpi,
  //    takže súbežná CUDZIA zmena toho istého variantu sa nemaskuje donekonečna.
  // Stabilná identita (`useCallback([])`, číta ref) — rovnaký dôvod ako
  // `useStaleResponseGuard`: nesmie rozbiť `load` memoizáciu / refirovať efekt.
  const reconcileResolved = useCallback((list: NedostupneList): NedostupneList => {
    const pending = pendingResolvedRef.current;
    if (pending.size === 0) return list;
    const groups = list.groups.map((g) => {
      const entry = pending.get(g.variantCode);
      if (entry === undefined) return g;
      if (g.resolved === entry.desired) {
        pending.delete(g.variantCode);
        return g;
      }
      if (entry.committed) pending.delete(g.variantCode);
      return { ...g, resolved: entry.desired };
    });
    return { ...list, groups };
  }, []);

  return { resolvedBusy, toggleResolved, reconcileResolved };
}
