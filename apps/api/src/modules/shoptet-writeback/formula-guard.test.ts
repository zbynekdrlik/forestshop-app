import { describe, expect, it } from "vitest";
import { csvSafe, FORMULA_LEAD_CHARS, startsWithFormulaChar } from "./formula-guard.js";

// issue 153: ochrana pred CSV-injection (hodnota začínajúca znakom vzorca).
// Vlastný súbor — čistá funkcia, žiadna DB/HTTP závislosť, `.claude/rules/
// testing.md`'s vzor (jednoduchá logika sa testuje samostatne, unit test).

describe("startsWithFormulaChar", () => {
  it.each(["=", "+", "-", "@"])("vráti true pre hodnotu začínajúcu '%s'", (znak) => {
    expect(startsWithFormulaChar(`${znak}cmd|'/c calc'!A1`)).toBe(true);
  });

  it("vráti false pre bežnú hodnotu (URL, kód)", () => {
    expect(startsWithFormulaChar("https://dodavatel.example.com/produkt")).toBe(false);
    expect(startsWithFormulaChar("4859/46")).toBe(false);
  });

  it("vráti false pre prázdny reťazec", () => {
    expect(startsWithFormulaChar("")).toBe(false);
  });

  it("FORMULA_LEAD_CHARS nesie presne štyri znaky z akceptačnej podmienky tiketu", () => {
    expect(FORMULA_LEAD_CHARS).toEqual(["=", "+", "-", "@"]);
  });
});

describe("csvSafe", () => {
  it("neutralizuje hodnotu začínajúcu znakom vzorca — predsadí jednoduchú úvodzovku", () => {
    expect(csvSafe("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(csvSafe("+1+1")).toBe("'+1+1");
    expect(csvSafe("-2+3")).toBe("'-2+3");
    expect(csvSafe("@SUM(1)")).toBe("'@SUM(1)");
  });

  it("nechá bežnú hodnotu bezo zmeny", () => {
    expect(csvSafe("https://dodavatel.example.com/x")).toBe("https://dodavatel.example.com/x");
    expect(csvSafe("4859/46")).toBe("4859/46");
    expect(csvSafe("")).toBe("");
  });
});
