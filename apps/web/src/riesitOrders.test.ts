import { expect, it } from "vitest";
import type { OrderLine, SupplierOpenOrders } from "./ordersApi.js";
import { groupRiesitLinesByOrder } from "./riesitOrders.js";

// issue 484: `groupRiesitLinesByOrder` preskupí `board.suppliers[].lines[]`
// (naprieč dodávateľmi) do plochého zoznamu OBJEDNÁVOK, najnovšia prvá.

function line(over: Partial<OrderLine> & Pick<OrderLine, "lineId" | "orderId" | "externalOrderId" | "placedAt">): OrderLine {
  return {
    customerName: "Zákazník",
    comment: null,
    remark: null,
    shopRemark: null,
    adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=x&src=orders",
    variantCode: "R-1",
    variantName: "Produkt",
    sizeLabel: null,
    ourUrl: null,
    quantity: 1,
    state: "riesit",
    ordered: false,
    supplierUrl: null,
    supplierNote: null,
    externalCode: null,
    supplierAssignable: false,
    manualSupplierOverride: null,
    customerOpenOrderCount: 1,
    ...over,
  };
}

const group = (supplier: string, lines: OrderLine[]): SupplierOpenOrders => ({ supplier, lines, email: null });

it("prázdny vstup → prázdny zoznam", () => {
  expect(groupRiesitLinesByOrder([])).toEqual([]);
});

it("riadky JEDNEJ objednávky u VIACERÝCH dodávateľov sa preskupia do jednej objednávky", () => {
  const a1 = line({ lineId: "l1", orderId: "o1", externalOrderId: "20261172", placedAt: "2026-08-01T00:00:00.000Z", customerName: "Novák", comment: "poznámka", variantCode: "A" });
  const a2 = line({ lineId: "l2", orderId: "o1", externalOrderId: "20261172", placedAt: "2026-08-01T00:00:00.000Z", customerName: "Novák", comment: "poznámka", variantCode: "B" });
  const a3 = line({ lineId: "l3", orderId: "o1", externalOrderId: "20261172", placedAt: "2026-08-01T00:00:00.000Z", customerName: "Novák", comment: "poznámka", variantCode: "C" });

  const orders = groupRiesitLinesByOrder([group("D1", [a1]), group("D2", [a2]), group("D3", [a3])]);

  expect(orders.length).toBe(1);
  const o = orders[0];
  expect(o?.orderId).toBe("o1");
  expect(o?.externalOrderId).toBe("20261172");
  expect(o?.customerName).toBe("Novák");
  expect(o?.comment).toBe("poznámka");
  // Všetky 3 riadky (naprieč dodávateľmi) pod jednou objednávkou.
  expect(o?.lines.map((l) => l.lineId)).toEqual(["l1", "l2", "l3"]);
});

it("viac objednávok → najnovšia (placedAt desc) prvá, pri zhode podľa čísla", () => {
  const older = line({ lineId: "l1", orderId: "o1", externalOrderId: "7001", placedAt: "2026-08-01T00:00:00.000Z" });
  const newer = line({ lineId: "l2", orderId: "o2", externalOrderId: "7002", placedAt: "2026-08-05T00:00:00.000Z" });
  const sameDayA = line({ lineId: "l3", orderId: "o3", externalOrderId: "7009", placedAt: "2026-08-05T00:00:00.000Z" });

  const orders = groupRiesitLinesByOrder([group("D", [older, newer, sameDayA])]);

  // najnovšie prvé; o2 aj o3 majú rovnaký placedAt → deterministicky podľa
  // externalOrderId (7002 < 7009), o1 (starší) naposledy.
  expect(orders.map((o) => o.orderId)).toEqual(["o2", "o3", "o1"]);
});
