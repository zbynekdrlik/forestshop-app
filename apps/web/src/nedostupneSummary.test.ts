import { describe, expect, it } from "vitest";
import { computeNedostupneGroupTotalPieces, formatNedostupneTotalChip } from "./nedostupneSummary.js";

// issue 443: celkový súčet kusov produktu naprieč objednávkami skupiny na
// "Nedostupné tovary" (odznak `Σ N` v hlavičke skupiny, ako na "Na objednanie").

describe("computeNedostupneGroupTotalPieces", () => {
  it("sčíta množstvá naprieč objednávkami", () => {
    expect(computeNedostupneGroupTotalPieces([{ quantity: 1 }, { quantity: 1 }])).toBe(2);
    expect(computeNedostupneGroupTotalPieces([{ quantity: 3 }, { quantity: 2 }, { quantity: 4 }])).toBe(9);
  });

  it("prázdny zoznam = 0", () => {
    expect(computeNedostupneGroupTotalPieces([])).toBe(0);
  });
});

describe("formatNedostupneTotalChip", () => {
  it("dve objednávky po 1 ks → 'Σ 2' (presne šéfov scenár)", () => {
    expect(formatNedostupneTotalChip([{ quantity: 1 }, { quantity: 1 }])).toEqual({
      text: "Σ 2",
      title: "Spolu vo všetkých objednávkach: 2 ks",
    });
  });

  it("rôzne množstvá sa sčítajú do odznaku", () => {
    expect(formatNedostupneTotalChip([{ quantity: 2 }, { quantity: 3 }])?.text).toBe("Σ 5");
  });

  it("jediná objednávka → žiadny odznak (null), inak by len zopakoval množstvo riadku", () => {
    expect(formatNedostupneTotalChip([{ quantity: 5 }])).toBeNull();
  });

  it("prázdna skupina → žiadny odznak (null)", () => {
    expect(formatNedostupneTotalChip([])).toBeNull();
  });
});
