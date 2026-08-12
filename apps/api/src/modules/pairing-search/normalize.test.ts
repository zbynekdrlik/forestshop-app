import { describe, expect, it } from "vitest";
import { cleanName, codePresent } from "./normalize.js";

// Fixtúry prevzaté priamo z `tests/test_normalize.py` starej appky (commit
// 60b6164, issue 387 E1) — over doslovnú zhodu správania.
describe("cleanName", () => {
  it("strips a leading order index", () => {
    expect(cleanName("01 Ponožky BOBR - jar/jeseň")).toBe("Ponožky BOBR - jar/jeseň");
  });

  it("collapses internal whitespace runs", () => {
    expect(cleanName("Bunda   FOREST\t1003")).toBe("Bunda FOREST 1003");
  });

  it("leaves a name without a leading index untouched", () => {
    expect(cleanName("Strike Nohavice DEERHUNTER 3989-388")).toBe("Strike Nohavice DEERHUNTER 3989-388");
  });

  it("strips a 1-3 digit leading index but never a 4+ digit product code", () => {
    expect(cleanName("100 Bunda FOREST")).toBe("Bunda FOREST");
    // "1003" is FOUR digits — the index pattern caps at \d{1,3}, so a
    // real product-code-like number at the start must survive untouched.
    expect(cleanName("1003 Bunda FOREST")).toBe("1003 Bunda FOREST");
  });

  it("never strips a leading index when it is followed by another number", () => {
    // The lookahead requires a non-digit right after the whitespace — two
    // consecutive numeric tokens are never an "index + name" shape.
    expect(cleanName("10 20 Bunda")).toBe("10 20 Bunda");
  });

  it("handles null/undefined/empty input", () => {
    expect(cleanName(null)).toBe("");
    expect(cleanName(undefined)).toBe("");
    expect(cleanName("")).toBe("");
    expect(cleanName("   ")).toBe("");
  });

  it("trims outer whitespace even without a leading index", () => {
    expect(cleanName("  Nôž lovecký Helle 110  ")).toBe("Nôž lovecký Helle 110");
  });
});

describe("codePresent", () => {
  // Regresný prípad zo `test_ranking.py`: krátky číselný kód "110" sa
  // NESMIE zhodnúť s podreťazcom dlhšieho čísla "1100".
  it("does not match a short numeric code as a substring of a longer run", () => {
    expect(codePresent("110", "Nôž Helle model 1100")).toBe(false);
  });

  it("matches a short numeric code as a whole delimited token", () => {
    expect(codePresent("110", "Nôž lovecký model 110 oceľ")).toBe(true);
  });

  it("matches at the start of the haystack", () => {
    expect(codePresent("OB570", "OB570 nohavice HART RANDO")).toBe(true);
  });

  it("matches at the end of the haystack", () => {
    expect(codePresent("OB570", "nohavice HART RANDO OB570")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(codePresent("ob570", "Nohavice HART RANDO OB570")).toBe(true);
    expect(codePresent("OB570", "nohavice hart rando ob570")).toBe(true);
  });

  it("does not match when the code is only a prefix of a longer token", () => {
    expect(codePresent("OB57", "nohavice HART RANDO OB570")).toBe(false);
  });

  it("does not match when the code is only a suffix of a longer token", () => {
    expect(codePresent("B570", "nohavice HART RANDO OB570")).toBe(false);
  });

  it("returns false for a missing code", () => {
    expect(codePresent(null, "anything")).toBe(false);
    expect(codePresent(undefined, "anything")).toBe(false);
    expect(codePresent("", "anything")).toBe(false);
  });

  it("returns false when the haystack does not contain the code at all", () => {
    expect(codePresent("ZZ9", "Bunda DEERHUNTER Strike 3989")).toBe(false);
  });

  it("escapes regex-special characters in the code", () => {
    expect(codePresent("3989-388", "produkt 3989-388 skladom")).toBe(true);
    expect(codePresent("3989-388", "produkt 39894388 skladom")).toBe(false);
  });
});
