import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// issue 164: INTERNÁ poznámka e-shopu (`shopRemark`, UŽ odvodená — LEN cudzí
// text, appkin vlastný blok nikdy neobsahuje) — vlastný súbor, rovnaký vzor
// ako `OrderLineRow.remarkCell.test.tsx` (`.claude/rules/frontend-design.md`).
const { fetchOpenOrders, fetchOrdersOverview } = vi.hoisted(() => ({ fetchOpenOrders: vi.fn(), fetchOrdersOverview: vi.fn() }));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchOpenOrders,
    fetchOrdersOverview };
});

const ZAKLAD = {
  orderId: "dddddddd-1111-0000-0000-000000000000",
  externalOrderId: "20261500",
  customerName: "Zákazník Zeta",
  comment: null,
  remark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=20261500&src=orders",
  placedAt: "2026-07-01T00:00:00.000Z",
  variantCode: "F-1",
  variantName: "Čiapka FOREST 6001",
  sizeLabel: null,
  quantity: 1,
  state: "objednane" as const,
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: false,
  manualSupplierOverride: null,
  customerOpenOrderCount: 1,
  ourUrl: null,
};

const RIADOK_BEZ_POZNAMKY = {
  ...ZAKLAD,
  lineId: "33333333-1111-0000-0000-000000000001",
  shopRemark: null,
};

const RIADOK_S_POZNAMKOU = {
  ...ZAKLAD,
  lineId: "33333333-1111-0000-0000-000000000002",
  externalOrderId: "20261501",
  shopRemark: "Zákazník je stavebná firma, vybaviť prednostne",
};

beforeEach(() => {
  fetchOrdersOverview.mockResolvedValue({ today: { orderCount: 0, revenue: "0.00" }, week: { orderCount: 0, revenue: "0.00" }, month: { orderCount: 0, revenue: "0.00" } });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("riadok bez internej poznámky e-shopu nevykreslí žiadny text v jej bunke", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Zeta", lines: [RIADOK_BEZ_POZNAMKY], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${RIADOK_BEZ_POZNAMKY.lineId}`);
  const bunka = within(riadok).getByTestId(`shop-remark-cell-${RIADOK_BEZ_POZNAMKY.lineId}`);
  expect(bunka.textContent).toBe("");
});

it("riadok S internou poznámkou e-shopu vykreslí jej text, read-only (bez vstupu)", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Zeta", lines: [RIADOK_S_POZNAMKOU], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${RIADOK_S_POZNAMKOU.lineId}`);
  const bunka = within(riadok).getByTestId(`shop-remark-cell-${RIADOK_S_POZNAMKOU.lineId}`);
  expect(bunka.textContent).toContain(RIADOK_S_POZNAMKOU.shopRemark);
  expect(bunka.querySelector("input,textarea")).toBeNull();
});
