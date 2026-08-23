import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrderLineStateButtons } from "./OrderLineStateButtons.js";
import type { OrderLine } from "../ordersApi.js";

afterEach(() => {
  cleanup();
});

const LINE: OrderLine = {
  lineId: "22222222-2222-2222-2222-222222222476",
  orderId: "bbbbbbbb-2222-2222-2222-222222222476",
  externalOrderId: "7100",
  customerName: "Zákazník",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=7100&src=orders",
  placedAt: "2026-08-01T00:00:00.000Z",
  variantCode: "S-1",
  variantName: "Produkt",
  sizeLabel: null,
  ourUrl: null,
  quantity: 1,
  state: "objednane",
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: false,
  manualSupplierOverride: null,
  customerOpenOrderCount: 1,
};

// issue 476: mockup Štěpán — 5 tlačidiel v poradí Nevybavené · Riešiť · Čaká sa
// · Skladom · Nedostupné (klaster 3+2 rieši CSS grid, tu overujeme PORADIE
// v DOM-e, ktoré do gridu vstupuje).
it("renderuje 5 stavových tlačidiel v mockup poradí vrátane Riešiť", () => {
  render(<OrderLineStateButtons line={LINE} busyLineId={null} onChangeState={() => {}} />);
  const labels = [...document.querySelectorAll(".ord-state-btn")].map((b) => b.textContent);
  expect(labels).toEqual(["Nevybavené", "Riešiť", "Čaká sa", "Skladom", "Nedostupné"]);
});

it("klik na Riešiť pošle onChangeState so stavom riesit", () => {
  const onChangeState = vi.fn();
  render(<OrderLineStateButtons line={LINE} busyLineId={null} onChangeState={onChangeState} />);
  fireEvent.click(screen.getByTestId(`state-btn-riesit-${LINE.lineId}`));
  expect(onChangeState).toHaveBeenCalledWith(LINE.lineId, "riesit");
});

it("klik na UŽ aktívny stav nepošle zbytočný zápis", () => {
  const onChangeState = vi.fn();
  render(<OrderLineStateButtons line={{ ...LINE, state: "riesit" }} busyLineId={null} onChangeState={onChangeState} />);
  fireEvent.click(screen.getByTestId(`state-btn-riesit-${LINE.lineId}`));
  expect(onChangeState).not.toHaveBeenCalled();
});
