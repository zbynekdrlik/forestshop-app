import { describe, expect, it } from "vitest";
import { MAIL_TEMPLATE_KINDS } from "../mail-templates/registry.js";
import { formatSupplierOrderMailText, type SupplierOrderMailLine } from "./mail.js";

// issue 192: pôvodné znenie objednávky dodávateľovi — presne to, čo appka
// pošle, kým ho majiteľ nezmení. Tieto testy sú zároveň dôkazom, že prechod
// na šablóny výsledný text NEZMENIL.
const SUPPLIER = MAIL_TEMPLATE_KINDS["supplier_order"].defaultText;

// Čisté funkcie (žiadna DB) — presné hranice slovenského skloňovania
// (0, 1, 2, 4, 5) a zloženie riadku, ktoré `formatSupplierOrderMailText`
// zdieľa medzi náhľadom aj odoslaním (`supplier-routes.ts`).
describe("formatSupplierOrderMailText", () => {
  it("predmet aj prvý riadok tela sú zhodné, jednotné číslo pre presne 1 položku", () => {
    const lines: SupplierOrderMailLine[] = [
      { variantCode: "40287", sizeLabel: null, quantity: 1, externalCode: null, supplierUrl: null },
    ];
    const { subject, body } = formatSupplierOrderMailText(SUPPLIER, "DODAVATEL-TEST-1", lines);
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
      externalCode: null,
      supplierUrl: null,
    }));
    const { subject } = formatSupplierOrderMailText(SUPPLIER, "Dodávateľ", lines);
    expect(subject).toBe(`Objednávka — Dodávateľ (${String(count)} ${expectedWord})`);
  });

  it("riadok s veľkosťou skladá kód | veľkosť | N ks", () => {
    const lines: SupplierOrderMailLine[] = [
      { variantCode: "4859/46", sizeLabel: "46", quantity: 3, externalCode: null, supplierUrl: null },
    ];
    const { body } = formatSupplierOrderMailText(SUPPLIER, "DODAVATEL-TEST-1", lines);
    expect(body.split("\n")[1]).toBe("4859/46 | 46 | 3 ks");
  });

  it("riadok bez veľkosti (jednovariantný produkt) vynechá prázdnu časť, nepridá prázdny stĺpec", () => {
    const lines: SupplierOrderMailLine[] = [
      { variantCode: "40287", sizeLabel: null, quantity: 2, externalCode: null, supplierUrl: null },
    ];
    const { body } = formatSupplierOrderMailText(SUPPLIER, "Dodávateľ", lines);
    expect(body.split("\n")[1]).toBe("40287 | 2 ks");
  });

  it("žiadne položky vyprodukuje predmet '0 položiek' a telo len s hlavičkou", () => {
    const { subject, body } = formatSupplierOrderMailText(SUPPLIER, "Prázdny dodávateľ", []);
    expect(subject).toBe("Objednávka — Prázdny dodávateľ (0 položiek)");
    expect(body).toBe(subject);
  });

  // issue 67: kód dodávateľa aj odkaz na tovar u dodávateľa — rovnaké poradie
  // ako stará appka's `orderCopyLines` (`kód | grube-id | veľkosť | N ks | url`).
  it("riadok s kódom dodávateľa aj odkazom zaradí oba na správne miesto", () => {
    const lines: SupplierOrderMailLine[] = [
      {
        variantCode: "4859/46",
        sizeLabel: "46",
        quantity: 3,
        externalCode: "OB832",
        supplierUrl: "https://www.huntingshop.eu/wild-t-green-nohavice",
      },
    ];
    const { body } = formatSupplierOrderMailText(SUPPLIER, "DODAVATEL-TEST-1", lines);
    expect(body.split("\n")[1]).toBe(
      "4859/46 | kód OB832 | 46 | 3 ks | https://www.huntingshop.eu/wild-t-green-nohavice",
    );
  });

  it("riadok len s kódom dodávateľa (bez odkazu) vynechá prázdnu časť pre odkaz", () => {
    const lines: SupplierOrderMailLine[] = [
      { variantCode: "40287", sizeLabel: null, quantity: 1, externalCode: "X1", supplierUrl: null },
    ];
    const { body } = formatSupplierOrderMailText(SUPPLIER, "Dodávateľ", lines);
    expect(body.split("\n")[1]).toBe("40287 | kód X1 | 1 ks");
  });
});
