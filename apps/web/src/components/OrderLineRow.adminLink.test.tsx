import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// issue 99: číslo objednávky sa stalo klikateľným odkazom do administrácie
// Shoptetu namiesto samostatnej ikonky `🔗` (issue 65). Vlastný súbor —
// `OrdersSection.test.tsx` je už na eslint `max-lines: 400` hranici
// (`.claude/rules/frontend-design.md`'s zavedený vzor: nový tematický súbor
// namiesto pridávania do veľkého existujúceho).
const { fetchOpenOrders, fetchOrdersOverview } = vi.hoisted(() => ({ fetchOpenOrders: vi.fn(), fetchOrdersOverview: vi.fn() }));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchOpenOrders,
    fetchOrdersOverview };
});

const LINE = {
  lineId: "55555555-5555-5555-5555-555555555555",
  orderId: "cccccccc-5555-5555-5555-555555555555",
  externalOrderId: "20261259",
  customerName: "Zákazník Gama",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=20261259&src=orders",
  placedAt: "2026-07-01T00:00:00.000Z",
  variantCode: "C-1",
  variantName: "Bunda FOREST 3001",
  sizeLabel: null,
  quantity: 1,
  state: "objednane" as const,
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: false,
  manualSupplierOverride: null,
};

beforeEach(() => {
  fetchOrdersOverview.mockResolvedValue({ today: { orderCount: 0, revenue: "0.00" }, week: { orderCount: 0, revenue: "0.00" }, month: { orderCount: 0, revenue: "0.00" } });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("číslo objednávky je odkaz do administrácie Shoptetu so správnym href/target/rel", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Gama", lines: [LINE], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${LINE.lineId}`);
  const odkaz = within(riadok).getByRole<HTMLAnchorElement>("link", {
    name: `Otvoriť objednávku ${LINE.externalOrderId} v administrácii Shoptet`,
  });
  expect(odkaz.href).toBe(LINE.adminUrl);
  expect(odkaz.target).toBe("_blank");
  expect(odkaz.rel).toBe("noreferrer noopener");
  // Samotný text odkazu je číslo objednávky — nie prázdna ikonka.
  expect(odkaz.textContent).toBe(LINE.externalOrderId);
});

it("v bunke objednávky neostáva žiadna samostatná ikonka odkazu (🔗)", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Gama", lines: [LINE], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${LINE.lineId}`);
  // issue 99: predtým bol vedľa čísla objednávky ešte SAMOSTATNÝ `<a>🔗</a>` —
  // po zmene má bunka presne JEDEN odkaz (samotné číslo), žiadnu ikonku.
  expect(within(riadok).getAllByRole("link", { name: /Otvoriť objednávku/ })).toHaveLength(1);
  expect(riadok.textContent).not.toContain("🔗");
});
