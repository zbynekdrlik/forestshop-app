import { describe, expect, it } from "vitest";
import { pickBest, rank } from "./ranking.js";
import type { PairingCandidate, PairingProduct } from "./types.js";

function product(name: string, externalCodes: readonly string[] = []): PairingProduct {
  return { productKey: "k", name, supplier: "BETALOV", externalCodes };
}

function candidate(name: string, url: string, code: string | null = null): PairingCandidate {
  return { name, url, code, price: null, rawScore: 0, codeHit: false };
}

// Fixtúry prevzaté z `tests/test_ranking.py` starej appky (commit 60b6164,
// issue 387 E1).
describe("pickBest", () => {
  it("scores a supplier-code match as high confidence, always above a pure name match", () => {
    const p = product("Nohavice HART RANDO XHP", ["OB570"]);
    const candidates = [candidate("Iné", "https://h/ine"), candidate("HART RANDO XHP nohavice", "https://h/hart-rando-ob570")];
    const { candidate: best, confidence } = pickBest(p, candidates);
    expect(confidence).toBe("high");
    expect(best?.url.toLowerCase()).toContain("ob570");
  });

  it("ranks the closest name match first among purely name-based candidates", () => {
    const p = product("Strike Nohavice DEERHUNTER 3989-388");
    const candidates = [
      candidate("Ciapka iná", "https://w/ciapka"),
      candidate("Strike Nohavice Deerhunter 3989", "https://w/strike-deerhunter-3989"),
    ];
    const ranked = rank(p, candidates);
    expect(ranked[0]?.url).toContain("deerhunter");
    const { candidate: best, confidence } = pickBest(p, candidates);
    expect(["high", "medium", "low"]).toContain(confidence);
    expect(best?.url).toBe("https://w/strike-deerhunter-3989");
  });

  it("returns none for an empty candidate list", () => {
    const { candidate: best, confidence } = pickBest(product("X"), []);
    expect(best).toBeNull();
    expect(confidence).toBe("none");
  });

  it("does NOT let a short numeric code false-match as a substring of a longer one", () => {
    // Regression: external_code '110' must NOT match candidate '...model 1100'.
    const p = product("Nôž lovecký Helle 110", ["110"]);
    const candidates = [candidate("Nôž Helle model 1100", "https://h/noz-helle-1100")];
    const { confidence } = pickBest(p, candidates);
    expect(confidence).not.toBe("high");
  });

  it("still boosts to high when a short code appears as a whole delimited token", () => {
    const p = product("Nôž 110", ["110"]);
    const candidates = [candidate("Nôž lovecký model 110 oceľ", "https://h/noz-110")];
    const { confidence } = pickBest(p, candidates);
    expect(confidence).toBe("high");
  });

  it("still returns the best (weak) candidate instead of null when the score is very low", () => {
    // Old appka's `pick_best` auto-fill: even a weak match is returned as
    // "low", never discarded — only an EMPTY candidate list yields "none".
    const p = product("Mikina softshell Pinewood zelená XL");
    const candidates = [candidate("Ciapka iná úplne odlišná", "https://w/ciapka")];
    const { candidate: best, confidence } = pickBest(p, candidates);
    expect(best).not.toBeNull();
    expect(confidence).toBe("low");
  });

  it("returns medium confidence for a solid name match without a code hit", () => {
    const p = product("Rukavice kožené čierne 42");
    const candidates = [candidate("Rukavice kožené čierne", "https://s/rukavice-kozene-cierne")];
    const { confidence } = pickBest(p, candidates);
    expect(confidence).toBe("medium");
  });
});

describe("rank — E1 multi-code adaptation (product carries several variant external codes)", () => {
  it("counts a code hit when ANY of the product's variant codes appears in the candidate (not just the first)", () => {
    const p = product("HART RANDO", ["60177/46", "60177/48"]);
    // Only the SECOND variant code ("60177/48") literally appears — proves
    // the check is not hardwired to `externalCodes[0]`.
    const candidates = [candidate("HART RANDO model 60177/48", "https://s/hart-rando")];
    const ranked = rank(p, candidates);
    expect(ranked[0]?.codeHit).toBe(true);
    expect(ranked[0]?.rawScore).toBeGreaterThanOrEqual(1000);
  });

  it("never mutates the input candidate array — returns new scored objects", () => {
    const p = product("HART RANDO", ["OB570"]);
    const original = candidate("Iné", "https://x/y");
    const candidates = [original];
    rank(p, candidates);
    expect(original.rawScore).toBe(0);
    expect(original.codeHit).toBe(false);
  });

  it("never counts a code hit when the product has no external codes at all", () => {
    const p = product("HART RANDO");
    const candidates = [candidate("HART RANDO model", "https://s/hart-rando")];
    const ranked = rank(p, candidates);
    expect(ranked[0]?.codeHit).toBe(false);
  });
});
