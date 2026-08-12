import { describe, expect, it } from "vitest";
import { tokenSetRatio } from "./token-set-ratio.js";

// Presné referenčné hodnoty odchytené z NAINŠTALOVANEJ `rapidfuzz` (pip,
// 3.14.5) — `rapidfuzz.fuzz.token_set_ratio(a, b)`, tá istá funkcia, akú
// volá stará appka (`ranking.py`'s `_name_score`), issue 387 E1. Celý
// algoritmus (LCS-based Indel `ratio` + token-set zoradenie/prienik) bol
// pred portom overený proti tejto knižnici na 700 náhodných/štruktúrovaných
// dvojiciach vrátane slovenskej diakritiky (0/700 nezhôd, scratchpad skript
// pri vývoji, nekomitovaný) — tu je fixovaná podmnožina ako regresný dôkaz.
describe("tokenSetRatio — exact parity fixtures vs. rapidfuzz.fuzz.token_set_ratio", () => {
  const cases: readonly [string, string, number][] = [
    // Case-sensitivity: rapidfuzz.fuzz.token_set_ratio is CASE-SENSITIVE by
    // default and the old appka never lowercases before calling it — a
    // token differing only in case does NOT count as an exact token match.
    ["Strike Nohavice DEERHUNTER 3989-388", "Strike Nohavice Deerhunter 3989", 66.66666666666666],
    ["HART RANDO XHP", "HART RANDO XHP nohavice", 100],
    ["Nôž lovecký Helle 110", "Nôž Helle model 1100", 78.04878048780488],
    ["Ponožky BOBR - jar/jeseň", "Ponožky BOBR jar jeseň merino", 79.24528301886792],
    ["Bunda FOREST 1003", "FOREST bunda zimná model 1003", 78.57142857142857],
    ["Nohavice HART RANDO XHP", "Iné", 0],
    ["Bunda DEERHUNTER Strike", "Bunda Deerhunter Strike", 68.57142857142857],
    ["rovnaky text", "rovnaky text", 100],
    ["Nôž 110", "Nôž lovecký model 110 oceľ", 100],
    ["Mikina softshell Pinewood zelená XL", "Softshell mikina PINEWOOD", 40],
    ["Ciapka iná", "Strike Nohavice Deerhunter 3989-388", 13.333333333333329],
  ];

  it.each(cases)("tokenSetRatio(%j, %j) ≈ %s", (a, b, expected) => {
    expect(tokenSetRatio(a, b)).toBeCloseTo(expected, 6);
  });

  it("returns 0 for empty or whitespace-only input on either side (rapidfuzz guard)", () => {
    expect(tokenSetRatio("", "abc")).toBe(0);
    expect(tokenSetRatio("abc", "")).toBe(0);
    expect(tokenSetRatio("   ", "abc")).toBe(0);
    expect(tokenSetRatio("", "")).toBe(0);
  });

  it("returns 100 for identical single-token strings", () => {
    expect(tokenSetRatio("a", "a")).toBe(100);
  });
});
