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
  ];

  it.each(cases)("„%s\" → %s", (raw, expected) => {
    expect(parseDecimalComma(raw)).toBe(expected);
  });
});

describe("parseDate", () => {
  it.each([
    ["2021-03-14", "2021-03-14"],
    ["", null],
    ["14.3.2021", null],
    ["2021-03-14 00:00:00", "2021-03-14"],
  ])("„%s\" → %s", (raw, expected) => {
    expect(parseDate(raw)).toBe(expected);
  });
});
