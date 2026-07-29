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
    guid: "guid-test-0001",
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
    ["", "", null],
    [" 40237/3XL ", " 40237", "3XL "],
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
      productKey: "0a486205-d9e7-11e0-92ec-e1ef0b66e031",
      guid: "0a486205-d9e7-11e0-92ec-e1ef0b66e031",
      sizeLabel: "3XL",
      pairCode: "1",
      name: "Nohavice FOREST 1003",
      supplier: null,
      currency: "EUR",
      price: "62.76",
      standardPrice: "66.08",
      purchasePrice: "34.27",
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
      productKey: "d63e07c9-3c48-11e6-8a3b-0cc47a6c92bc",
      guid: "d63e07c9-3c48-11e6-8a3b-0cc47a6c92bc",
      sizeLabel: null,
      pairCode: null,
      name: "Čiapka Polar FOREST",
      price: "14.62",
      currency: "EUR",
      stock: -111,
      state: "sellable",
    });
  });

  // CRITICAL (task-5-fix-1): identita produktu je `guid`, nie prefix `code` pred
  // lomkou — `splitCode` (prefix) sa na reálnom exporte v oboch smeroch mýlil:
  // zlučoval nesúvisiace produkty pod rovnaký prefix a rozdeľoval jeden produkt
  // naprieč viacerými prefixmi. `productKey` (a nový stĺpec `guid`) musia byť
  // odvodené z `row["guid"]`, nikdy z `code`.
  it("productKey je guid z riadku, nie prefix code pred lomkou — aj keď sa prefixy zhodujú", () => {
    const a = mapRow(bareRow({ code: "AAA/1", guid: "guid-shared" })).record;
    const b = mapRow(bareRow({ code: "BBB/2", guid: "guid-shared" })).record;
    // Rôzne prefixy, ten istý guid → ten istý productKey (predtým by sa toto
    // ticho rozdelilo na dva produkty, čo je presne opravovaný under-merge).
    expect(a?.productKey).toBe("guid-shared");
    expect(b?.productKey).toBe("guid-shared");
    expect(a?.productKey).toBe(b?.productKey);
  });

  it("rovnaký prefix code, iný guid → iný productKey (predtým by sa ticho zlúčili)", () => {
    const a = mapRow(bareRow({ code: "997/1", guid: "guid-a" })).record;
    const b = mapRow(bareRow({ code: "997/2", guid: "guid-b" })).record;
    expect(a?.productKey).toBe("guid-a");
    expect(b?.productKey).toBe("guid-b");
    expect(a?.productKey).not.toBe(b?.productKey);
  });

  it("zmapuje akciovú cenu aj s dátumom od", () => {
    const { record } = mapRow(fixtureRow("40269/3XL"));
    expect(record).toMatchObject({
      code: "40269/3XL",
      actionPrice: "46.99",
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
    expect(mapRow(fixtureRow("4859/46")).record?.supplier).toBe("DODAVATEL-TEST-1");
  });
});

describe("mapRow — anomálie", () => {
  it("prázdny kód nevyrobí záznam, ale vyrobí problém", () => {
    const { record, issues } = mapRow(bareRow({ code: "" }));
    expect(record).toBeNull();
    expect(issues).toEqual([{ kind: "empty_code", code: "", detail: { name: "Testovací produkt" } }]);
  });

  it("kód začínajúci lomkou (prázdny productKey) nevyrobí záznam, ale vyrobí problém", () => {
    const { record, issues } = mapRow(bareRow({ code: "/M" }));
    expect(record).toBeNull();
    expect(issues).toEqual([{ kind: "empty_code", code: "/M", detail: { name: "Testovací produkt" } }]);
  });

  // CRITICAL (task-5-fix-1): `guid` je identita produktu, takže prázdny `guid`
  // sa zaobchádza rovnako ako prázdny `code` — žiadny fallback, žiadny záznam.
  it("prázdny guid nevyrobí záznam, ale vyrobí problém", () => {
    const { record, issues } = mapRow(bareRow({ guid: "" }));
    expect(record).toBeNull();
    expect(issues).toEqual([{ kind: "empty_guid", code: "TEST/1", detail: { name: "Testovací produkt" } }]);
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
    expect(record).toMatchObject({
      currency: null,
      price: null,
      standardPrice: null,
      purchasePrice: null,
      actionPrice: null,
    });
    expect(issues).toEqual([
      { kind: "missing_currency", code: "TEST/1", detail: { price: "10,00", standardPrice: "12,00" } },
    ]);
  });

  it("suma bez meny, keď jedinou prítomnou sumou je purchasePrice, sa tiež zahodí celá", () => {
    const { record, issues } = mapRow(bareRow({ purchasePrice: "32,68", currency: "" }));
    expect(record).toMatchObject({
      currency: null,
      price: null,
      standardPrice: null,
      purchasePrice: null,
      actionPrice: null,
    });
    expect(issues).toEqual([
      { kind: "missing_currency", code: "TEST/1", detail: { purchasePrice: "32,68" } },
    ]);
  });

  it("nečitateľný sklad sa berie ako 0 a zapíše sa problém", () => {
    const { record, issues } = mapRow(bareRow({ stock: "veľa" }));
    expect(record?.stock).toBe(0);
    expect(issues).toEqual([
      { kind: "invalid_stock", code: "TEST/1", detail: { raw: "veľa" } },
    ]);
  });

  it("desatinný a preto nie striktne celočíselný sklad sa berie ako 0 a zapíše sa problém", () => {
    const { record, issues } = mapRow(bareRow({ stock: "3.9" }));
    expect(record?.stock).toBe(0);
    expect(issues).toEqual([
      { kind: "invalid_stock", code: "TEST/1", detail: { raw: "3.9" } },
    ]);
  });

  it("sklad so zvyškovým textom ('12abc') sa berie ako 0 a zapíše sa problém", () => {
    const { record, issues } = mapRow(bareRow({ stock: "12abc" }));
    expect(record?.stock).toBe(0);
    expect(issues).toEqual([
      { kind: "invalid_stock", code: "TEST/1", detail: { raw: "12abc" } },
    ]);
  });

  it("prázdny sklad je 0 a nie je to anomália", () => {
    const { record, issues } = mapRow(bareRow({ stock: "" }));
    expect(record?.stock).toBe(0);
    expect(issues).toEqual([]);
  });

  it("includingVat '0' sa mapuje na false", () => {
    const { record } = mapRow(bareRow({ includingVat: "0" }));
    expect(record?.includingVat).toBe(false);
  });
});

describe("mapRow — číselné hranice stĺpcov (mimo rozsah = anomália, riadok prežije)", () => {
  it("cena presne na hranici numeric(12,2) prejde", () => {
    const { record, issues } = mapRow(bareRow({ price: "9999999999,00", currency: "EUR" }));
    expect(issues).toEqual([]);
    expect(record?.price).toBe("9999999999.00");
  });

  it("cena za hranicou numeric(12,2) sa zahodí ako anomália, riadok stále vyrobí záznam", () => {
    const { record, issues } = mapRow(bareRow({ price: "12345678901234,00", currency: "EUR" }));
    expect(record).not.toBeNull();
    expect(record?.price).toBeNull();
    expect(issues).toEqual([
      { kind: "invalid_money", code: "TEST/1", detail: { field: "price", raw: "12345678901234,00" } },
    ]);
  });

  it("percentVat presne na hranici numeric(5,2) prejde", () => {
    const { record, issues } = mapRow(bareRow({ percentVat: "999,99" }));
    expect(issues).toEqual([]);
    expect(record?.percentVat).toBe("999.99");
  });

  it("percentVat za hranicou numeric(5,2) sa zahodí ako anomália a zapíše sa problém", () => {
    const { record, issues } = mapRow(bareRow({ percentVat: "1000" }));
    expect(record).not.toBeNull();
    expect(record?.percentVat).toBeNull();
    expect(issues).toEqual([
      { kind: "invalid_money", code: "TEST/1", detail: { field: "percentVat", raw: "1000" } },
    ]);
  });

  it("sklad presne na hranici int4 prejde", () => {
    const { record, issues } = mapRow(bareRow({ stock: "2147483647" }));
    expect(issues).toEqual([]);
    expect(record?.stock).toBe(2147483647);
  });

  it("sklad za hranicou int4 sa berie ako 0 a zapíše sa problém", () => {
    const { record, issues } = mapRow(bareRow({ stock: "2147483648" }));
    expect(record?.stock).toBe(0);
    expect(issues).toEqual([
      { kind: "invalid_stock", code: "TEST/1", detail: { raw: "2147483648" } },
    ]);
  });
});
