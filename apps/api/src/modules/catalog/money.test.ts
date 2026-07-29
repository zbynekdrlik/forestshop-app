import { describe, expect, it } from "vitest";
import { parseDate, parseDecimalComma } from "./money.js";

describe("parseDecimalComma", () => {
  const cases: readonly [string, string | null][] = [
    ["67,00", "67.00"],
    ["64,90", "64.90"],
    ["1249,00", "1249.00"],
    ["9,00", "9.00"],
    ["48,00", "48.00"],
    ["23", "23"],
    ["0,00", "0.00"],
    ["-1,50", "-1.50"],
    ["1 249,00", "1249.00"], // medzera ako oddeľovač tisícov
    ["1 249,00", "1249.00"], // nezalomiteľná medzera
    ["67.00", "67.00"], // bodka je rovnako platná
    ["", null],
    ["   ", null],
    ["n/a", null],
    ["67,00 EUR", null],
    ["6 7,00", null], // medzera NIE je oddeľovač tisícov tu (nenasledujú 3 číslice)
    ["67,004", "67.00"], // zaokrúhlenie nadol
    ["67,005", "67.01"], // zaokrúhlenie „pol nahor od nuly"
    ["-67,005", "-67.01"], // rovnaké pravidlo aj so záporným znamienkom
  ];

  it.each(cases)("„%s\" → %s", (raw, expected) => {
    expect(parseDecimalComma(raw)).toBe(expected);
  });
});

describe("parseDecimalComma — medza celočíselnej časti (numeric(precision, 2))", () => {
  it("10 číslic (numeric(12,2) menových stĺpcov) presne na hranici prejde", () => {
    expect(parseDecimalComma("9999999999,00")).toBe("9999999999.00");
  });

  it("11 číslic (za hranicou numeric(12,2)) sa zahodí ako mimo rozsahu", () => {
    expect(parseDecimalComma("12345678901234,00")).toBeNull();
  });

  it("vlastný limit (napr. 3 číslice pre percentVat numeric(5,2)) — presne na hranici prejde", () => {
    expect(parseDecimalComma("999,99", 3)).toBe("999.99");
  });

  it("vlastný limit — za hranicou sa zahodí", () => {
    expect(parseDecimalComma("1000", 3)).toBeNull();
  });
});

describe("parseDate", () => {
  it.each([
    ["2021-03-14", "2021-03-14"],
    ["", null],
    ["14.3.2021", null],
    ["2021-03-14 00:00:00", "2021-03-14"],
    ["2021-03-14T00:00:00", "2021-03-14"], // T-separátor (ISO 8601), nielen medzera
  ])("„%s\" → %s", (raw, expected) => {
    expect(parseDate(raw)).toBe(expected);
  });
});
