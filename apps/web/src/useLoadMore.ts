import { useCallback, useRef, useState, type RefObject } from "react";

// issue 337: "Načítať ďalšie" — zdieľaný mechanizmus pre KAŽDÚ stránkovanú
// vyhľadávaciu obrazovku (Katalóg/Kontrola párovania/Eshop → Párovanie
// produktov/Eshop → Párovanie, issue 387 E5). Backend `page`/`pageSize`
// už podporuje plnohodnotne (viď `.claude/rules` per-modul poznámky) — chýbal
// len spôsob, ako sa z frontendu dostať za prvú stranu. Rieši VÝHRADNE
// "načítaj ĎALŠIU stranu a pripoj k existujúcim položkám" — samotné NOVÉ
// vyhľadávanie (zmena dopytu/filtra) ostáva vo `search()` každej obrazovky
// nezmenené (nahrádza `items` a strana sa vracia na 1), volajúci na jeho
// ZAČIATKU zavolá `reset()`.
export interface LoadMorePage<T> {
  readonly items: readonly T[];
  readonly total: number;
}

/**
 * `reset()` zvýši generáciu — akákoľvek ODPOVEĎ na "load more" požiadavku
 * vyslanú PRED resetom (teda patriacu STARÉMU dopytu/filtru) sa pri doručení
 * zahodí, rovnaký "latest generation" princíp ako existujúci `searchSeq`
 * vzor v týchto komponentoch (`.claude/rules/frontend-design.md`'s "latest
 * ref" záznamy), len o úroveň vyššie (pre CELÚ load-more sekvenciu, nie pre
 * jedno volanie).
 */
export function useLoadMore<T>(params: {
  readonly mountedRef: RefObject<boolean>;
  readonly onAppend: (items: readonly T[], total: number) => void;
  readonly onError: () => void;
}): {
  readonly loadMore: (fetchNextPage: (page: number) => Promise<LoadMorePage<T>>) => void;
  readonly loadingMore: boolean;
  readonly reset: () => void;
} {
  const pageRef = useRef(1);
  const genRef = useRef(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const { mountedRef, onAppend, onError } = params;

  // requesting-code-review finding (issue 337): `reset()` bumps the
  // generation so a stale in-flight `loadMore()`'s `.finally()` skips its
  // own `setLoadingMore(false)` (the `gen === genRef.current` guard is now
  // false) — WITHOUT this line nothing else ever clears it, so the button
  // is stuck showing "Načítavam…"/`disabled` for the rest of the component
  // instance's life the moment a new search starts while a "load more"
  // request is still in flight (an entirely ordinary sequence: click "Load
  // more", then submit a new search before page 2 lands).
  const reset = useCallback(() => {
    pageRef.current = 1;
    genRef.current += 1;
    setLoadingMore(false);
  }, []);

  const loadMore = useCallback(
    (fetchNextPage: (page: number) => Promise<LoadMorePage<T>>) => {
      const gen = genRef.current;
      const nextPage = pageRef.current + 1;
      setLoadingMore(true);
      fetchNextPage(nextPage)
        .then((result) => {
          if (!mountedRef.current || gen !== genRef.current) return;
          pageRef.current = nextPage;
          onAppend(result.items, result.total);
        })
        .catch(() => {
          if (!mountedRef.current || gen !== genRef.current) return;
          onError();
        })
        .finally(() => {
          if (mountedRef.current && gen === genRef.current) setLoadingMore(false);
        });
    },
    [mountedRef, onAppend, onError],
  );

  return { loadMore, loadingMore, reset };
}
