import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SupplierActionsPanel } from "./SupplierActionsPanel.js";
import type { OrderLine, SupplierOpenOrders } from "../ordersApi.js";

afterEach(() => {
  cleanup();
});

const makeLine = (overrides: Partial<OrderLine> = {}): OrderLine => ({
  lineId: overrides.lineId ?? "l1",
  orderId: "o1",
  externalOrderId: "1001",
  customerName: "Zákazník",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=1001&src=orders",
  placedAt: "2026-07-01T00:00:00.000Z",
  variantCode: "A-1",
  variantName: "Produkt",
  sizeLabel: null,
  quantity: 1,
  state: "objednane",
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: false,
  manualSupplierOverride: null,
  ...overrides,
});

// issue 263: hlavička skupiny dodávateľa (`.toorder-supplier`) je VEDĽAJŠÍ
// nosič tých istých troch stavov ako filtračný čip (`OrdersToolbar.tsx`) —
// `done` (všetko vybavené, rovnaký výpočet ako čip) a `active` (táto skupina
// je PRÁVE TERAZ vybraný filter, `selectedSupplier === group.supplier`).
function renderPanel(group: SupplierOpenOrders, selectedSupplier: string | null): void {
  render(
    <SupplierActionsPanel
      group={group}
      canChangeState={true}
      editingEmailSupplier={null}
      emailDraft=""
      emailBusy={false}
      emailError=""
      onEmailDraftChange={() => {}}
      onStartEditEmail={() => {}}
      onSaveEmail={() => {}}
      onCancelEditEmail={() => {}}
      busyOrderedSupplier={null}
      busyOrderedLineId={null}
      onToggleGroupOrdered={() => {}}
      onCopyOrderToClipboard={() => {}}
      previewSupplier={null}
      preview={null}
      previewError=""
      sendBusy={false}
      sendResult={null}
      onOpenPreview={() => {}}
      onClosePreview={() => {}}
      onConfirmSend={() => {}}
      selectedSupplier={selectedSupplier}
    />,
  );
}

it("skupina s nespracovanými riadkami (nevybraná) nesie hlavičku BEZ 'done'/'active'", () => {
  const group: SupplierOpenOrders = {
    supplier: "Dodávateľ Todo",
    email: null,
    lines: [makeLine({ lineId: "t1", state: "objednane", ordered: false })],
  };
  renderPanel(group, null);

  const hlavicka = screen.getByTestId("supplier-contact-Dodávateľ Todo").closest(".toorder-supplier");
  expect(hlavicka).not.toBeNull();
  expect(hlavicka?.className).not.toContain("done");
  expect(hlavicka?.className).not.toContain("active");
});

it("skupina, kde sú všetky riadky vybavené, nesie hlavičku s 'done'", () => {
  const group: SupplierOpenOrders = {
    supplier: "Dodávateľ Hotový",
    email: null,
    lines: [makeLine({ lineId: "d1", state: "skladom" })],
  };
  renderPanel(group, null);

  const hlavicka = screen.getByTestId("supplier-contact-Dodávateľ Hotový").closest(".toorder-supplier");
  expect(hlavicka?.className).toContain("done");
  expect(hlavicka?.className).not.toContain("active");
});

it("skupina, ktorá je PRÁVE TERAZ vybraný filter, nesie hlavičku s 'active' (prebíja 'done')", () => {
  const group: SupplierOpenOrders = {
    supplier: "Dodávateľ Hotový",
    email: null,
    lines: [makeLine({ lineId: "d2", state: "skladom" })],
  };
  renderPanel(group, "Dodávateľ Hotový");

  const hlavicka = screen.getByTestId("supplier-contact-Dodávateľ Hotový").closest(".toorder-supplier");
  expect(hlavicka?.className).toContain("active");
  expect(hlavicka?.className).toContain("done");
});
