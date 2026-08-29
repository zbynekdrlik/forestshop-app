import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useStaleResponseGuard } from "./useStaleResponseGuard.js";

it("begin() vráti rastúce sekvenčné čísla", () => {
  const { result } = renderHook(() => useStaleResponseGuard());
  expect(result.current.begin()).toBe(1);
  expect(result.current.begin()).toBe(2);
  expect(result.current.begin()).toBe(3);
});

it("isLatest je true pre NAJNOVŠÍ begin() a false pre starší (stale vetva)", () => {
  const { result } = renderHook(() => useStaleResponseGuard());
  const stary = result.current.begin();
  const novy = result.current.begin();

  // Odpoveď na starší fetch doletí AŽ po novom → musí sa zahodiť.
  expect(result.current.isLatest(stary)).toBe(false);
  // Odpoveď na najnovší fetch sa smie uplatniť.
  expect(result.current.isLatest(novy)).toBe(true);
});

it("jediný prebiehajúci fetch je latest, kým nezačne ďalší", () => {
  const { result } = renderHook(() => useStaleResponseGuard());
  const seq = result.current.begin();
  expect(result.current.isLatest(seq)).toBe(true);
});

it("cancel() znehodnotí prebiehajúci fetch bez začatia nového", () => {
  const { result } = renderHook(() => useStaleResponseGuard());
  const seq = result.current.begin();
  expect(result.current.isLatest(seq)).toBe(true);

  // Napr. dialóg sa zavrel skôr, než odpoveď doletela — jej `.then()` sa
  // po doručení musí zahodiť.
  result.current.cancel();
  expect(result.current.isLatest(seq)).toBe(false);

  // Ďalší begin() po cancel-e pokračuje v číslovaní (žiadny reset na 0).
  expect(result.current.begin()).toBe(3);
});

it("metódy sú STABILNÉ medzi rendermi (identita sa nemení)", () => {
  const { result, rerender } = renderHook(() => useStaleResponseGuard());
  const prve = result.current;
  rerender();
  expect(result.current).toBe(prve);
  expect(result.current.begin).toBe(prve.begin);
  expect(result.current.isLatest).toBe(prve.isLatest);
  expect(result.current.cancel).toBe(prve.cancel);
});
