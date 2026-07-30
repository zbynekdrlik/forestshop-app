import { describe, expect, it } from "vitest";
import { formatSupplierOrderMailText, type SupplierOrderMailLine } from "./mail.js";

// Čisté funkcie (žiadna DB) — presné hranice slovenského skloňovania
// (0, 1, 2, 4, 5) a zloženie riadku, ktoré `formatSupplierOrderMailText`
// zdieľa medzi náhľadom aj odoslaním (`supplier-routes.ts`).
describe("formatSupplierOrderMailText", () => {
  it("predmet aj prvý riadok tela sú zhodné, jednotné číslo pre presne 1 položku", () => {
    const lines: SupplierOrderMailLine[] = [{ variantCode: "40287", sizeLabel: null, quantity: 1 }];
    const { subject, body } = formatSupplierOrderMailText("DODAVATEL-TEST-1", lines);
    expect(subject).toBe("Objednávka — DODAVATEL-TEST-1 (1 položka)");
    expect(body.split("\n")[0]).toBe(subject);
  });

  it.each([
    [0, "položiek"],
    [1, "položka"],
    [2, "položky"],
    [4, "položky"],
    [5, "položiek"],
    [11, "položiek"],
  ])("skloňovanie pre %i položiek je '%s'", (count, expectedWord) => {
    const lines: SupplierOrderMailLine[] = Array.from({ length: count }, (_, i) => ({
      variantCode: `KOD-${String(i)}`,
      sizeLabel: null,
      quantity: 1,
    }));
    const { subject } = formatSupplierOrderMailText("Dodávateľ", lines);
    expect(subject).toBe(`Objednávka — Dodávateľ (${String(count)} ${expectedWord})`);
  });

  it("riadok s veľkosťou skladá kód | veľkosť | N ks", () => {
    const lines: SupplierOrderMailLine[] = [{ variantCode: "4859/46", sizeLabel: "46", quantity: 3 }];
    const { body } = formatSupplierOrderMailText("DODAVATEL-TEST-1", lines);
    expect(body.split("\n")[1]).toBe("4859/46 | 46 | 3 ks");
  });

  it("riadok bez veľkosti (jednovariantný produkt) vynechá prázdnu časť, nepridá prázdny stĺpec", () => {
    const lines: SupplierOrderMailLine[] = [{ variantCode: "40287", sizeLabel: null, quantity: 2 }];
    const { body } = formatSupplierOrderMailText("Dodávateľ", lines);
    expect(body.split("\n")[1]).toBe("40287 | 2 ks");
  });

  it("žiadne položky vyprodukuje predmet '0 položiek' a telo len s hlavičkou", () => {
    const { subject, body } = formatSupplierOrderMailText("Prázdny dodávateľ", []);
    expect(subject).toBe("Objednávka — Prázdny dodávateľ (0 položiek)");
    expect(body).toBe(subject);
  });
});
