import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// issue 431: pri mene zákazníka sa v "Na objednanie" má zobraziť krúžkový
// odznak s počtom OTVORENÝCH objednávok toho istého zákazníka — LEN keď ≥ 2
// (signál "zváž zlúčenie"). Zákazník s 1 objednávkou odznak nemá.
const { fetchOpenOrders, fetchOrdersOverview } = vi.hoisted(() => ({
  fetchOpenOrders: vi.fn(),
  fetchOrdersOverview: vi.fn(),
}));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchOpenOrders, fetchOrdersOverview };
});

const BASE_LINE = {
  lineId: "11111111-1111-1111-1111-111111111111",
  orderId: "aaaaaaaa-1111-1111-1111-111111111111",
  externalOrderId: "20261355",
  customerName: "Juraj Petro",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=20261355&src=orders",
  placedAt: "2026-08-12T00:00:00.000Z",
  variantCode: "61713",
  variantName: "Pletená čiapka DEERHUNTER Recon Beanie",
  sizeLabel: null,
  ourUrl: null,
  quantity: 1,
  state: "objednane" as const,
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: false,
  manualSupplierOverride: null,
  customerOpenOrderCount: 3,
};

const LINE_JEDNA = {
  ...BASE_LINE,
  lineId: "22222222-2222-2222-2222-222222222222",
  orderId: "bbbbbbbb-2222-2222-2222-222222222222",
  externalOrderId: "20261360",
  customerName: "Anna Nová",
  variantCode: "61999",
  customerOpenOrderCount: 1,
};

beforeEach(() => {
  fetchOrdersOverview.mockResolvedValue({
    today: { orderCount: 0, revenue: "0.00" },
    week: { orderCount: 0, revenue: "0.00" },
    month: { orderCount: 0, revenue: "0.00" },
  });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("zákazník s ≥2 otvorenými objednávkami má pri mene odznak so správnym počtom", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [BASE_LINE], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${BASE_LINE.lineId}`);
  const odznak = within(riadok).getByTestId(`cust-order-badge-${BASE_LINE.lineId}`);
  expect(odznak.textContent).toBe("3");
  expect(odznak.getAttribute("title")).toBe("zákazník má 3 otvorené objednávky — zvážiť zlúčenie");
  // Meno ostáva vedľa odznaku čitateľné.
  expect(within(riadok).getByText("Juraj Petro")).toBeTruthy();
});

it("zákazník s 1 otvorenou objednávkou odznak nemá", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_JEDNA], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${LINE_JEDNA.lineId}`);
  expect(within(riadok).queryByTestId(`cust-order-badge-${LINE_JEDNA.lineId}`)).toBeNull();
});
