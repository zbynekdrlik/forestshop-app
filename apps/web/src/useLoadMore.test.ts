import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useLoadMore } from "./useLoadMore.js";

function mountedRef(value = true): { readonly current: boolean } {
  return { current: value };
}

it("loadMore zavolá fetchNextPage so stranou 2 a pripojí výsledok cez onAppend", async () => {
  const onAppend = vi.fn();
  const onError = vi.fn();
  const { result } = renderHook(() => useLoadMore<string>({ mountedRef: mountedRef(), onAppend, onError }));

  const fetchNextPage = vi.fn().mockResolvedValue({ items: ["b"], total: 3 });
  await act(async () => {
    result.current.loadMore(fetchNextPage);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(fetchNextPage).toHaveBeenCalledWith(2);
  expect(onAppend).toHaveBeenCalledWith(["b"], 3);
  expect(onError).not.toHaveBeenCalled();
  expect(result.current.loadingMore).toBe(false);
});

it("druhé loadMore po úspešnom prvom žiada stranu 3, nie znova stranu 2", async () => {
  const onAppend = vi.fn();
  const { result } = renderHook(() =>
    useLoadMore<string>({ mountedRef: mountedRef(), onAppend, onError: vi.fn() }),
  );

  const fetchPage2 = vi.fn().mockResolvedValue({ items: ["b"], total: 5 });
  await act(async () => {
    result.current.loadMore(fetchPage2);
    await Promise.resolve();
    await Promise.resolve();
  });

  const fetchPage3 = vi.fn().mockResolvedValue({ items: ["c"], total: 5 });
  await act(async () => {
    result.current.loadMore(fetchPage3);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(fetchPage3).toHaveBeenCalledWith(3);
});

it("reset() vráti stranu späť na 1 — ĎALŠIE loadMore znova žiada stranu 2", async () => {
  const { result } = renderHook(() =>
    useLoadMore<string>({ mountedRef: mountedRef(), onAppend: vi.fn(), onError: vi.fn() }),
  );

  const fetchPage2 = vi.fn().mockResolvedValue({ items: ["b"], total: 5 });
  await act(async () => {
    result.current.loadMore(fetchPage2);
    await Promise.resolve();
    await Promise.resolve();
  });

  act(() => {
    result.current.reset();
  });

  const fetchAfterReset = vi.fn().mockResolvedValue({ items: ["x"], total: 2 });
  await act(async () => {
    result.current.loadMore(fetchAfterReset);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(fetchAfterReset).toHaveBeenCalledWith(2);
});

// issue 337: `reset()` volaný ZATIAĽ ČO staršie "load more" volanie ešte
// čaká na odpoveď (napr. užívateľ zmenil dopyt/filter kým predchádzajúca
// strana ešte doletovala) MUSÍ zahodiť tú neskoro doručenú, k STARÉMU
// dopytu patriacu odpoveď — inak by `onAppend` pripojil položky z INÉHO
// vyhľadávania k práve nahradenému zoznamu (rovnaká trieda race ako
// `.claude/rules/frontend-design.md`'s "latest ref"/`searchSeq` nálezy).
it("odpoveď na load-more požiadavku vyslanú PRED reset()-om sa po doručení zahodí (generation guard)", async () => {
  const onAppend = vi.fn();
  const onError = vi.fn();
  const { result } = renderHook(() => useLoadMore<string>({ mountedRef: mountedRef(), onAppend, onError }));

  let resolveStale: ((page: { items: string[]; total: number }) => void) | undefined;
  const staleFetch = vi.fn(
    () =>
      new Promise<{ items: string[]; total: number }>((resolve) => {
        resolveStale = resolve;
      }),
  );

  act(() => {
    result.current.loadMore(staleFetch);
  });

  act(() => {
    result.current.reset();
  });

  await act(async () => {
    resolveStale?.({ items: ["stale"], total: 99 });
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(onAppend).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

it("keď fetchNextPage zlyhá, zavolá sa onError a loadingMore sa vráti na false", async () => {
  const onAppend = vi.fn();
  const onError = vi.fn();
  const { result } = renderHook(() => useLoadMore<string>({ mountedRef: mountedRef(), onAppend, onError }));

  const failing = vi.fn().mockRejectedValue(new Error("network"));
  await act(async () => {
    result.current.loadMore(failing);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(onError).toHaveBeenCalledTimes(1);
  expect(onAppend).not.toHaveBeenCalled();
  expect(result.current.loadingMore).toBe(false);
});

it("keď komponent už nie je mountnutý (mountedRef.current === false), onAppend/onError sa nezavolajú", async () => {
  const ref = mountedRef(true);
  const onAppend = vi.fn();
  const onError = vi.fn();
  const { result } = renderHook(() => useLoadMore<string>({ mountedRef: ref, onAppend, onError }));

  const fetchNextPage = vi.fn().mockResolvedValue({ items: ["b"], total: 3 });
  act(() => {
    result.current.loadMore(fetchNextPage);
  });
  (ref as { current: boolean }).current = false;

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(onAppend).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});
