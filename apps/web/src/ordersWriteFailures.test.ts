import { expect, it } from "vitest";
import {
  clearWriteFailure,
  formatWriteFailuresHeading,
  lineWhere,
  orderWhere,
  upsertWriteFailure,
  type OrderWriteFailure,
} from "./ordersWriteFailures.js";
import type { OrderLine, SupplierOpenOrders } from "./ordersApi.js";

const LINE: OrderLine = {
  lineId: "11111111-1111-1111-1111-111111111111",
  orderId: "aaaaaaaa-1111-1111-1111-111111111111",
  externalOrderId: "1001",
  customerName: "Zákazník",
  comment: null,
  remark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=1001&src=orders",
  placedAt: "2026-07-01T00:00:00.000Z",
  variantCode: "A-1",
  variantName: "Nohavice FOREST",
  sizeLabel: "3XL",
  quantity: 2,
  state: "objednane",
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: false,
  manualSupplierOverride: null,
};

const SUPPLIERS: readonly SupplierOpenOrders[] = [{ supplier: "Dodávateľ Alfa", lines: [LINE], email: null }];

it("upsertWriteFailure pridá novú položku", () => {
  const result = upsertWriteFailure([], { id: "state:1", what: "Zmena stavu", where: "obj. 1001", detail: "chyba" });
  expect(result).toEqual([{ id: "state:1", what: "Zmena stavu", where: "obj. 1001", detail: "chyba" }]);
});

it("upsertWriteFailure s ROVNAKÝM id NAHRADÍ predchádzajúcu položku, nikdy ju neduplikuje", () => {
  const puvodny: readonly OrderWriteFailure[] = [
    { id: "state:1", what: "Zmena stavu", where: "obj. 1001", detail: "prvá chyba" },
  ];
  const result = upsertWriteFailure(puvodny, {
    id: "state:1",
    what: "Zmena stavu",
    where: "obj. 1001",
    detail: "druhá chyba",
  });
  expect(result).toHaveLength(1);
  expect(result[0]?.detail).toBe("druhá chyba");
});

it("upsertWriteFailure s INÝM id PRIDÁ NEZÁVISLÚ položku (kumulatívne, nikdy neprepíše cudziu)", () => {
  const puvodny: readonly OrderWriteFailure[] = [
    { id: "state:1", what: "Zmena stavu", where: "obj. 1001", detail: "chyba A" },
  ];
  const result = upsertWriteFailure(puvodny, {
    id: "ordered:2",
    what: "Príznak objednané",
    where: "obj. 1002",
    detail: "chyba B",
  });
  expect(result).toHaveLength(2);
  expect(result.map((f) => f.id)).toEqual(["state:1", "ordered:2"]);
});

it("clearWriteFailure zmaže LEN položku so zhodným id, ostatné nechá bez zmeny", () => {
  const puvodny: readonly OrderWriteFailure[] = [
    { id: "state:1", what: "Zmena stavu", where: "obj. 1001", detail: "chyba A" },
    { id: "ordered:2", what: "Príznak objednané", where: "obj. 1002", detail: "chyba B" },
  ];
  const result = clearWriteFailure(puvodny, "state:1");
  expect(result).toEqual([{ id: "ordered:2", what: "Príznak objednané", where: "obj. 1002", detail: "chyba B" }]);
});

it("clearWriteFailure na chýbajúce id je no-op", () => {
  const puvodny: readonly OrderWriteFailure[] = [
    { id: "state:1", what: "Zmena stavu", where: "obj. 1001", detail: "chyba" },
  ];
  expect(clearWriteFailure(puvodny, "neznáme")).toEqual(puvodny);
});

it("formatWriteFailuresHeading skloňuje po slovensky (1/2-4/5+)", () => {
  expect(formatWriteFailuresHeading(1)).toBe("⚠️ Nepodarilo sa uložiť 1 položku");
  expect(formatWriteFailuresHeading(2)).toBe("⚠️ Nepodarilo sa uložiť 2 položky");
  expect(formatWriteFailuresHeading(4)).toBe("⚠️ Nepodarilo sa uložiť 4 položky");
  expect(formatWriteFailuresHeading(5)).toBe("⚠️ Nepodarilo sa uložiť 5 položiek");
  expect(formatWriteFailuresHeading(0)).toBe("⚠️ Nepodarilo sa uložiť 0 položiek");
});

it("lineWhere nájde riadok podľa lineId naprieč skupinami dodávateľov", () => {
  expect(lineWhere(SUPPLIERS, LINE.lineId)).toBe("obj. 1001, kód A-1");
});

it("lineWhere na neznámy lineId vráti prázdny reťazec (riadok medzitým zmizol zo zoznamu)", () => {
  expect(lineWhere(SUPPLIERS, "neznámy")).toBe("");
});

it("orderWhere nájde PRVÝ riadok s daným orderId (poznámka patrí objednávke, nie riadku)", () => {
  expect(orderWhere(SUPPLIERS, LINE.orderId)).toBe("obj. 1001");
});

it("orderWhere na neznámy orderId vráti prázdny reťazec", () => {
  expect(orderWhere(SUPPLIERS, "neznáme")).toBe("");
});
