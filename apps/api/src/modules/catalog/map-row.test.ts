import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseShoptetCsv } from "./csv.js";
import { mapRow, splitCode } from "./map-row.js";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("./fixtures/shoptet-sample.csv", import.meta.url)),
);

function fixtureRow(code: string): Readonly<Record<string, string>> {
  for (const row of parseShoptetCsv(FIXTURE).rows()) {
    if (row["code"] === code) return row;
  }
  throw new Error(`Fixtúra neobsahuje kód ${code}`);
}

function bareRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    code: "TEST/1",
    pairCode: "",
    name: "Testovací produkt",
    supplier: "",
    price: "",
    standardPrice: "",
    purchasePrice: "",
    currency: "",
    includingVat: "",
    percentVat: "",
    actionPrice: "",
    actionFrom: "",
    actionUntil: "",
    stock: "0",
    availabilityInStock: "",
    availabilityOutOfStock: "",
    productVisibility: "visible",
    ...overrides,
  };
}

describe("splitCode", () => {
  it.each([
    ["40237/3XL", "40237", "3XL"],
    ["4859/46", "4859", "46"],
    ["60055/8", "60055", "8"],
    ["40287", "40287", null],
    ["278", "278", null],
    ["BR1611", "BR1611", null],
    ["AB/", "AB", null],
    ["A/B/C", "A", "B/C"],
  ])("„%s\" → %s + %s", (code, productKey, sizeLabel) => {
    expect(splitCode(code)).toEqual({ productKey, sizeLabel });
  });
});

describe("mapRow nad reálnymi riadkami fixtúry", () => {
  it("zmapuje viacveľkostný variant so zápornými skladmi", () => {
    const { record, issues } = mapRow(fixtureRow("40237/3XL"));
    expect(issues).toEqual([]);
    expect(record).toMatchObject({
      code: "40237/3XL",
      productKey: "40237",
      sizeLabel: "3XL",
      pairCode: "1",
      name: "Nohavice FOREST 1003",
      supplier: null,
      currency: "EUR",
      price: "67.00",
      standardPrice: "71.00",
      purchasePrice: "32.68",
      actionPrice: null,
      actionFrom: null,
      percentVat: "23",
      includingVat: true,
      stock: -11,
      availabilityText: "Predaj výrobku skončil",
      productVisibility: "visible",
      state: "discontinued",
    });
  });

  it("zmapuje jednovariantný produkt s prázdnym pairCode", () => {
    const { record } = mapRow(fixtureRow("40287"));
    expect(record).toMatchObject({
      code: "40287",
      productKey: "40287",
      sizeLabel: null,
      pairCode: null,
      name: "Čiapka Polar FOREST",
      price: "9.00",
      currency: "EUR",
      stock: -111,
      state: "sellable",
    });
  });

  it("zmapuje akciovú cenu aj s dátumom od", () => {
    const { record } = mapRow(fixtureRow("40269/3XL"));
    expect(record).toMatchObject({
      code: "40269/3XL",
      actionPrice: "48.00",
      actionFrom: "2021-03-14",
      actionUntil: null,
    });
  });

  it("ponechá pôvodné texty dostupnosti nepreložené", () => {
    const { record } = mapRow(fixtureRow("60055/8"));
    expect(record).toMatchObject({
      availabilityInStockText: "Predaj výrobku skončil",
      availabilityOutOfStockText: "Vypredané",
      availabilityText: "Vypredané",
      state: "out_of_stock",
    });
  });

  it("zapíše dodávateľa, keď ho export uvádza", () => {
    expect(mapRow(fixtureRow("4859/46")).record?.supplier).toBe("BETALOV");
  });
});

describe("mapRow — anomálie", () => {
  it("prázdny kód nevyrobí záznam, ale vyrobí problém", () => {
    const { record, issues } = mapRow(bareRow({ code: "" }));
    expect(record).toBeNull();
    expect(issues).toEqual([{ kind: "empty_code", code: "", detail: { name: "Testovací produkt" } }]);
  });

  it("nečitateľná suma sa zahodí a zapíše sa problém", () => {
    const { record, issues } = mapRow(bareRow({ price: "n/a", currency: "EUR" }));
    expect(record?.price).toBeNull();
    expect(issues).toEqual([
      { kind: "invalid_money", code: "TEST/1", detail: { field: "price", raw: "n/a" } },
    ]);
  });

  it("suma bez meny sa zahodí celá — inak by ju odmietol CHECK v databáze", () => {
    const { record, issues } = mapRow(bareRow({ price: "10,00", standardPrice: "12,00", currency: "" }));
    expect(record).toMatchObject({ currency: null, price: null, standardPrice: null });
    expect(issues).toEqual([
      { kind: "missing_currency", code: "TEST/1", detail: { price: "10,00" } },
    ]);
  });

  it("nečitateľný sklad sa berie ako 0 a zapíše sa problém", () => {
    const { record, issues } = mapRow(bareRow({ stock: "veľa" }));
    expect(record?.stock).toBe(0);
    expect(issues).toEqual([
      { kind: "invalid_stock", code: "TEST/1", detail: { raw: "veľa" } },
    ]);
  });

  it("prázdny sklad je 0 a nie je to anomália", () => {
    const { record, issues } = mapRow(bareRow({ stock: "" }));
    expect(record?.stock).toBe(0);
    expect(issues).toEqual([]);
  });
});
