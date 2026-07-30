import { describe, expect, it } from "vitest";
import { normalizeSupplierKeyJs, pickCanonicalSupplierSpelling } from "./supplier-key.js";

describe("normalizeSupplierKeyJs", () => {
  it("orezáva okrajové medzery", () => {
    expect(normalizeSupplierKeyJs("  Citrade  ")).toBe("citrade");
  });

  it("zlučuje viacnásobné vnútorné medzery na jednu", () => {
    expect(normalizeSupplierKeyJs("Citrade   s.r.o.")).toBe("citrade s.r.o.");
  });

  it("ignoruje veľkosť písmen", () => {
    expect(normalizeSupplierKeyJs("HUNTING24")).toBe(normalizeSupplierKeyJs("Hunting24"));
  });

  it("dva rôzne dodávatelia (nielen pravopis) dajú rôzny kľúč", () => {
    expect(normalizeSupplierKeyJs("LASTING")).not.toBe(normalizeSupplierKeyJs("LASITNG"));
  });
});

describe("pickCanonicalSupplierSpelling", () => {
  it("vyberie jediný pravopis, keď je len jeden", () => {
    expect(pickCanonicalSupplierSpelling(new Map([["Citrade", 3]]))).toBe("Citrade");
  });

  it("vyberie NAJČASTEJŠÍ pravopis podľa počtu riadkov", () => {
    const counts = new Map([
      ["HUNTING24", 3],
      ["Hunting24", 25],
    ]);
    expect(pickCanonicalSupplierSpelling(counts)).toBe("Hunting24");
  });

  it("remíza sa rozhodne abecedne (deterministicky)", () => {
    const counts = new Map([
      ["Werra", 1],
      ["WERRA", 1],
    ]);
    // "WERRA" < "Werra" (veľké 'E' má nižší kód než malé 'e')
    expect(pickCanonicalSupplierSpelling(counts)).toBe("WERRA");
  });

  it("prázdna množina pravopisov hádže chybu (nemalo by nikdy nastať)", () => {
    expect(() => pickCanonicalSupplierSpelling(new Map())).toThrow();
  });
});
