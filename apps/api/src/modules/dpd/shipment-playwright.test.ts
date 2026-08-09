import { describe, expect, it } from "vitest";
import { extractParcelNumber } from "./shipment-playwright.js";

// Code review (issue 292, PR 324): appka's vlastná referencia
// (`externalOrderId`, typicky 8-miestne Shoptet objednávkové číslo) je v
// riadku VŽDY prítomná (appka podľa nej riadok vyhľadala), takže naivné
// "prvá 8+ miestna číslica v texte" by ju vrátilo namiesto skutočného
// (naživo pozorovaného 14-miestneho) čísla zásielky.
describe("extractParcelNumber", () => {
  const reference = "20261234";

  it("finds the real parcel number when the reference appears first in the text", () => {
    expect(extractParcelNumber(`${reference} Ján Testovací 12345678901234`, reference)).toBe("12345678901234");
  });

  it("finds the parcel number from a plain notification sentence", () => {
    expect(extractParcelNumber("Zásielka uložená, číslo 99900000123", reference)).toBe("99900000123");
  });

  it("never returns the reference itself, even if it were the only long-enough number present", () => {
    expect(extractParcelNumber(`referencia ${reference}00`, `${reference}00`)).toBeNull();
  });

  it("returns null when nothing long enough is found, never guesses a short number", () => {
    expect(extractParcelNumber(`${reference} bez ďalšieho čísla`, reference)).toBeNull();
  });
});
