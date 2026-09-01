import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
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
}): { readonly resolvedBusy: string; readonly toggleResolved: (variantCode: string, resolved: boolean) => void } {
  const { setList, setActionError, onSessionExpired } = deps;
  // Prebiehajúci zápis pre daný variant — checkbox je počas neho `disabled`,
  // aby dvojklik nespustil dva protichodné zápisy.
  const [resolvedBusy, setResolvedBusy] = useState("");

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
      setGroupResolved(variantCode, resolved);
      setNedostupneResolved(variantCode, resolved)
        .catch((err: unknown) => {
          // Vráť optimistickú zmenu späť — server je zdroj pravdy.
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

  return { resolvedBusy, toggleResolved };
}
