import { describe, expect, it } from "vitest";
import { deriveVariantState, effectiveAvailabilityText, type VariantState } from "./availability.js";

describe("effectiveAvailabilityText", () => {
  it("pri kladnom sklade použije text pre skladom", () => {
    expect(
      effectiveAvailabilityText({ stock: 5, inStockText: "Skladom", outOfStockText: "Vypredané" }),
    ).toBe("Skladom");
  });

  it("pri nulovom a zápornom sklade použije text pre vypredané", () => {
    expect(
      effectiveAvailabilityText({ stock: 0, inStockText: "Skladom", outOfStockText: "Vypredané" }),
    ).toBe("Vypredané");
    expect(
      effectiveAvailabilityText({ stock: -1, inStockText: "Skladom", outOfStockText: "Vypredané" }),
    ).toBe("Vypredané");
  });

  it("keď je zvolený text prázdny, siahne po tom druhom", () => {
    expect(
      effectiveAvailabilityText({ stock: 0, inStockText: "Skladom", outOfStockText: "" }),
    ).toBe("Skladom");
  });

  it("keď sú prázdne obidva, vráti prázdny reťazec", () => {
    expect(effectiveAvailabilityText({ stock: -15, inStockText: "", outOfStockText: "" })).toBe("");
  });

  it("pri kladnom sklade a prázdnom texte pre skladom siahne po texte pre vypredané", () => {
    expect(
      effectiveAvailabilityText({ stock: 5, inStockText: "", outOfStockText: "Vypredané" }),
    ).toBe("Vypredané");
  });
});

describe("deriveVariantState — skutočné reťazce z exportu", () => {
  const cases: readonly [string, number, string, string, string, VariantState][] = [
    // popis prípadu, stock, inStock, outOfStock, productVisibility, očakávaný stav
    ["40237/M — Skladom pri zápornom sklade", -3, "Skladom", "Skladom", "visible", "sellable"],
    ["4859/46 — Skladom pri kladnom sklade", 5, "Skladom", "Predaj výrobku skončil", "visible", "sellable"],
    ["40287 — Skladom, detailOnly, sklad -111", -111, "Skladom", "Skladom", "detailOnly", "sellable"],
    ["český Skladem", 3, "Skladem", "", "visible", "sellable"],
    ["Dodanie 1-3 dni", 2, "Dodanie 1-3 dni", "", "visible", "sellable"],
    ["Predobjednávka", 1, "Predobjednávka", "", "visible", "sellable"],
    ["60055/8 — Vypredané", -1, "Predaj výrobku skončil", "Vypredané", "detailOnly", "out_of_stock"],
    ["278 — Není skladem", 0, "", "Není skladem", "detailOnly", "out_of_stock"],
    ["malé není skladem", 0, "", "není skladem", "visible", "out_of_stock"],
    ["diakritika-free variant 'neni skladem'", 0, "", "neni skladem", "visible", "out_of_stock"],
    ["Momentálne nedostupné", 0, "", "Momentálne nedostupné", "visible", "out_of_stock"],
    ["40237/L — obidva texty prázdne, záporný sklad", -15, "", "", "visible", "out_of_stock"],
    ["prázdne texty, kladný sklad", 4, "", "", "visible", "sellable"],
    ["40237/3XL — Predaj výrobku skončil", -11, "Predaj výrobku skončil", "Predaj výrobku skončil", "visible", "discontinued"],
    ["text obsahuje oba markery naraz — vypredané aj skončilo", -1, "", "Vypredané, predaj výrobku skončil", "visible", "discontinued"],
    // "hidden" texty zámerne NEobsahujú "skon"/"vypredan" — inak by test prešiel
    // aj po odstránení "hidden" z HIDDEN_VISIBILITIES (pravidlo by sa nepripol).
    ["60035/3XL — hidden", 0, "Skladom", "Skladom", "hidden", "discontinued"],
    ["BR1611 — blocked so Skladom", -2, "Skladom", "Skladom", "blocked", "discontinued"],
    ["cashDeskOnly so Skladom", 7, "Skladom", "Skladom", "cashDeskOnly", "discontinued"],
    ["blockUnregistered so Skladom", 7, "Skladom", "Skladom", "blockUnregistered", "discontinued"],
  ];

  it.each(cases)("%s", (_popis, stock, inStockText, outOfStockText, productVisibility, expected) => {
    expect(deriveVariantState({ stock, inStockText, outOfStockText, productVisibility })).toBe(
      expected,
    );
  });
});
