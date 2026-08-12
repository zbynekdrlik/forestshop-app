import { describe, expect, it } from "vitest";
import { buildQueryLadder, buildQueryVariants, GENERIC_WORDS } from "./queries.js";
import type { PairingProduct } from "./types.js";

function product(name: string, externalCodes: readonly string[] = []): PairingProduct {
  return { productKey: "k", name, supplier: "BETALOV", externalCodes };
}

// query ladder — port `tests/test_matcher.py` + `tests/test_normalize.py`'s
// `build_query` scenarios (starej appky, commit 60b6164), tu overené na
// hlave `buildQueryLadder` (nahrádza starý samostatný `build_query`).
describe("buildQueryLadder", () => {
  it("prefers the external code over the name", () => {
    expect(buildQueryLadder(product("Nohavice HART RANDO XHP", ["OB570"]))[0]).toBe("OB570");
  });

  it("uses the clean full name (as the first rung) when there is no external code", () => {
    expect(buildQueryLadder(product("Strike Nohavice DEERHUNTER 3989-388"))[0]).toBe(
      "Strike Nohavice DEERHUNTER 3989-388",
    );
  });

  it("falls back through 3-token then 2-token prefixes for a long name", () => {
    // Port `test_matcher.py`'s `test_falls_back_to_shorter_query_when_code_and_full_name_miss`:
    // ladder = [code, full name, first-3, first-2], deduped.
    const p = product("Bunda DEERHUNTER Strike 3989", ["ZZ9"]);
    expect(buildQueryLadder(p)).toEqual([
      "ZZ9",
      "Bunda DEERHUNTER Strike 3989",
      "Bunda DEERHUNTER Strike",
      "Bunda DEERHUNTER",
    ]);
  });

  it("does not add a first-3/first-2 rung for a name with 2 or fewer tokens", () => {
    expect(buildQueryLadder(product("Opasok kožený"))).toEqual(["Opasok kožený"]);
  });

  it("tries ALL distinct variant external codes before falling back to the name (E1 adaptation)", () => {
    // The old appka carried exactly one `external_code` per grouped product;
    // here it is a per-variant column, so every distinct code gets its own
    // rung before the name-based ones. (Name kept to <=2 tokens so no
    // first-3/first-2 rung is added, isolating the multi-code behavior.)
    const p = product("HART RANDO", ["60177/46", "60177/48"]);
    expect(buildQueryLadder(p)).toEqual(["60177/46", "60177/48", "HART RANDO"]);
  });

  it("deduplicates identical variant codes while preserving first-seen order", () => {
    const p = product("HART RANDO", ["OB570", "OB570"]);
    expect(buildQueryLadder(p)).toEqual(["OB570", "HART RANDO"]);
  });

  it("returns an empty ladder for a product with no name and no codes", () => {
    expect(buildQueryLadder(product(""))).toEqual([]);
  });
});

// query variants — port `tests/test_gather.py` (starej appky, commit
// 60b6164).
describe("buildQueryVariants", () => {
  it("puts the external code first", () => {
    const variants = buildQueryVariants(product("Nohavice HART RANDO XHP", ["OB570"]));
    expect(variants[0]).toBe("OB570");
  });

  it("produces the full name, the generic-stripped form, and prefix groups, with no duplicates", () => {
    const variants = buildQueryVariants(product("Nohavice HART RANDO XHP"));
    expect(variants).toContain("Nohavice HART RANDO XHP");
    expect(variants).toContain("HART RANDO XHP");
    expect(variants).toContain("Nohavice HART RANDO");
    expect(new Set(variants).size).toBe(variants.length);
  });

  it("does not strip a generic word that is not the leading token", () => {
    // GENERIC-word stripping only ever removes a LEADING run of tokens
    // (`matcher.py`'s query_variants loop starts at i=0 and only advances
    // forward, stopping the instant the current token is non-generic) —
    // a 2-token name has no prefix/suffix groups either (needs >2 tokens),
    // so the ONLY variant produced is the untouched full name.
    expect(buildQueryVariants(product("HART nohavice"))).toEqual(["HART nohavice"]);
  });

  it("never strips ALL tokens even if the whole name is generic", () => {
    // `while i < len(toks) - 1` keeps at least one token.
    const variants = buildQueryVariants(product("Nohavice Bunda"));
    expect(variants).toContain("Bunda");
    expect(variants).not.toContain("");
  });

  it("includes prefix and suffix token groups for both the full and stripped names", () => {
    const variants = buildQueryVariants(product("Nohavice HART RANDO XHP MODEL"));
    // full name (5 tokens): prefix-3, suffix-3, prefix-2, suffix-2
    expect(variants).toContain("Nohavice HART RANDO"); // prefix-3
    expect(variants).toContain("RANDO XHP MODEL"); // suffix-3
    expect(variants).toContain("Nohavice HART"); // prefix-2
    expect(variants).toContain("XHP MODEL"); // suffix-2
    // stripped name (4 tokens, leading "Nohavice" removed)
    expect(variants).toContain("HART RANDO XHP"); // prefix-3 of stripped
    expect(variants).toContain("RANDO XHP MODEL"); // suffix-3 of stripped
  });

  it("carries ALL distinct variant external codes, each deduplicated (E1 adaptation)", () => {
    const p = product("HART RANDO XHP", ["OB570", "OB571", "OB570"]);
    const variants = buildQueryVariants(p);
    expect(variants.slice(0, 2)).toEqual(["OB570", "OB571"]);
  });

  it("returns an empty list for a product with no name and no codes", () => {
    expect(buildQueryVariants(product(""))).toEqual([]);
  });
});

describe("GENERIC_WORDS", () => {
  it("carries both diacritic and stripped-diacritic forms, ported verbatim from the old appka", () => {
    // Spot-check a representative sample from `matcher.py`'s GENERIC set —
    // full 46-word parity is exercised indirectly by the stripping tests
    // above.
    for (const word of ["nohavice", "bunda", "košeľa", "kosela", "ponožky", "membrána", "membrana"]) {
      expect(GENERIC_WORDS.has(word)).toBe(true);
    }
    expect(GENERIC_WORDS.size).toBe(46);
  });
});
