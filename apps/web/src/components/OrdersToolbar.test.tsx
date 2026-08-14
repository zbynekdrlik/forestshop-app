import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrdersToolbar } from "./OrdersToolbar.js";
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
  customerOpenOrderCount: 0,
  ourUrl: null,
  ...overrides,
});

const SUPPLIERS: readonly SupplierOpenOrders[] = [
  {
    supplier: "Dodávateľ Alfa",
    email: null,
    lines: [makeLine({ lineId: "a1", state: "objednane", ordered: false })],
  },
  {
    supplier: "Dodávateľ Beta",
    email: null,
    lines: [makeLine({ lineId: "b1", state: "caka_sa", ordered: false })],
  },
];

it("zobrazí chip 'Všetci' aj chip pre každého dodávateľa s počtom riadkov", () => {
  render(
    <OrdersToolbar
      suppliers={SUPPLIERS}
      selectedSupplier={null}
      onSelectSupplier={() => {}}
      hideResolved={false}
      onToggleHideResolved={() => {}}
    />,
  );

  expect(screen.getByTestId("supplier-chip-all").textContent).toBe("Všetci (2)");
  expect(screen.getByTestId("supplier-chip-Dodávateľ Alfa").textContent).toBe("Dodávateľ Alfa (1)");
  expect(screen.getByTestId("supplier-chip-Dodávateľ Beta").textContent).toBe("Dodávateľ Beta (1)");
});

it("klik na chip dodávateľa zavolá onSelectSupplier s jeho menom", () => {
  const onSelectSupplier = vi.fn();
  render(
    <OrdersToolbar
      suppliers={SUPPLIERS}
      selectedSupplier={null}
      onSelectSupplier={onSelectSupplier}
      hideResolved={false}
      onToggleHideResolved={() => {}}
    />,
  );

  fireEvent.click(screen.getByTestId("supplier-chip-Dodávateľ Beta"));
  expect(onSelectSupplier).toHaveBeenCalledWith("Dodávateľ Beta");
});

it("klik na 'Všetci' zavolá onSelectSupplier s null", () => {
  const onSelectSupplier = vi.fn();
  render(
    <OrdersToolbar
      suppliers={SUPPLIERS}
      selectedSupplier="Dodávateľ Alfa"
      onSelectSupplier={onSelectSupplier}
      hideResolved={false}
      onToggleHideResolved={() => {}}
    />,
  );

  fireEvent.click(screen.getByTestId("supplier-chip-all"));
  expect(onSelectSupplier).toHaveBeenCalledWith(null);
});

it("vybraný chip nesie triedu 'active', dodávateľ bez nevybavených riadkov triedu 'done'", () => {
  const doneSupplier: readonly SupplierOpenOrders[] = [
    { supplier: "Hotový", email: null, lines: [makeLine({ lineId: "h1", state: "skladom" })] },
  ];
  render(
    <OrdersToolbar
      suppliers={doneSupplier}
      selectedSupplier="Hotový"
      onSelectSupplier={() => {}}
      hideResolved={false}
      onToggleHideResolved={() => {}}
    />,
  );

  const chip = screen.getByTestId("supplier-chip-Hotový");
  expect(chip.className).toContain("active");
  expect(chip.className).toContain("done");
});

// issue 263: majiteľ, doslovne "'Všetci' chip keeps its neutral/selected
// behaviour — it has no data state of its own" — na rozdiel od skutočných
// dodávateľských čipov (`chip.done`/žiadny modifikátor = zelená/červená dátový
// stav) čip "Všetci" dostáva VŽDY `chip-all` (nikdy `done`, aj keď sú VŠETKY
// riadky naprieč VŠETKÝMI dodávateľmi vybavené) — farba jeho pozadia je
// neutrálna alebo (keď je vybraný) rovnaká `active` oranžová ako každý iný čip.
it("čip 'Všetci' nesie triedu 'chip-all' a NIKDY 'done', aj keď sú všetky riadky vybavené", () => {
  const vsetkoHotove: readonly SupplierOpenOrders[] = [
    { supplier: "Dodávateľ Hotový", email: null, lines: [makeLine({ lineId: "h1", state: "skladom" })] },
  ];
  render(
    <OrdersToolbar
      suppliers={vsetkoHotove}
      selectedSupplier={null}
      onSelectSupplier={() => {}}
      hideResolved={false}
      onToggleHideResolved={() => {}}
    />,
  );

  const vsetciChip = screen.getByTestId("supplier-chip-all");
  expect(vsetciChip.className).toContain("chip-all");
  expect(vsetciChip.className).not.toContain("done");

  const dodavatelChip = screen.getByTestId("supplier-chip-Dodávateľ Hotový");
  expect(dodavatelChip.className).not.toContain("chip-all");
  expect(dodavatelChip.className).toContain("done");
});

it("súhrn počíta 'Všetci' cez všetky riadky a mení sa podľa vybraného dodávateľa", () => {
  const { rerender } = render(
    <OrdersToolbar
      suppliers={SUPPLIERS}
      selectedSupplier={null}
      onSelectSupplier={() => {}}
      hideResolved={false}
      onToggleHideResolved={() => {}}
    />,
  );
  expect(screen.getByTestId("orders-summary").textContent).toBe("Ostáva vybaviť 1 z 2 · Čaká sa 1");

  rerender(
    <OrdersToolbar
      suppliers={SUPPLIERS}
      selectedSupplier="Dodávateľ Beta"
      onSelectSupplier={() => {}}
      hideResolved={false}
      onToggleHideResolved={() => {}}
    />,
  );
  expect(screen.getByTestId("orders-summary").textContent).toBe("Dodávateľ Beta: ostáva vybaviť 0 z 1 · Čaká sa 1");
});

it("prepínač 'skryť vybavené' zobrazí správny text podľa stavu a klik zavolá callback", () => {
  const onToggleHideResolved = vi.fn();
  const { rerender } = render(
    <OrdersToolbar
      suppliers={SUPPLIERS}
      selectedSupplier={null}
      onSelectSupplier={() => {}}
      hideResolved={false}
      onToggleHideResolved={onToggleHideResolved}
    />,
  );

  const toggle = screen.getByTestId("orders-hide-resolved-toggle");
  expect(toggle.textContent).toBe("👁 Skryť vybavené");
  fireEvent.click(toggle);
  expect(onToggleHideResolved).toHaveBeenCalledTimes(1);

  rerender(
    <OrdersToolbar
      suppliers={SUPPLIERS}
      selectedSupplier={null}
      onSelectSupplier={() => {}}
      hideResolved={true}
      onToggleHideResolved={onToggleHideResolved}
    />,
  );
  expect(screen.getByTestId("orders-hide-resolved-toggle").textContent).toBe("🙈 Vybavené skryté");
});
