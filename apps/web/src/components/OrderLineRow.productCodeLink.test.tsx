import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// issue 276: majiteľ, "pod číslom objednávky nech je aj kód produktu,
// prelinkovaný na náš eshop — niekedy sa musím pozrieť, ako ten produkt
// vyzerá". Vlastný súbor — `OrderLineRow.adminLink.test.tsx` je tematicky
// najbližší (rovnaká bunka `.ord-order-cell`), ale založenie NOVÉHO súboru
// drží `.claude/rules/frontend-design.md`'s zavedený vzor pre samostatnú
// funkciu namiesto pridávania do existujúceho.
const { fetchOpenOrders, fetchOrdersOverview } = vi.hoisted(() => ({ fetchOpenOrders: vi.fn(), fetchOrdersOverview: vi.fn() }));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchOpenOrders,
    fetchOrdersOverview };
});

const LINE_ZNAMY = {
  lineId: "66666666-6666-6666-6666-666666666666",
  orderId: "cccccccc-6666-6666-6666-666666666666",
  externalOrderId: "20261300",
  customerName: "Zákazník Delta",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=20261300&src=orders",
  placedAt: "2026-08-01T00:00:00.000Z",
  variantCode: "60542",
  variantName: "Nohavice Hart Wild-T",
  sizeLabel: null,
  quantity: 1,
  state: "objednane" as const,
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: false,
  manualSupplierOverride: null,
  ourUrl: "https://www.forestshop.sk/nohavice-hart-wild-t/?variantId=60542",
};

const LINE_NEZNAMY = { ...LINE_ZNAMY, lineId: "77777777-7777-7777-7777-777777777777", variantCode: "99999/ZZ", ourUrl: null };

beforeEach(() => {
  fetchOrdersOverview.mockResolvedValue({ today: { orderCount: 0, revenue: "0.00" }, week: { orderCount: 0, revenue: "0.00" }, month: { orderCount: 0, revenue: "0.00" } });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("kód produktu, ktorý poznáme z feedu, je kliknuteľný odkaz na náš eshop v novej karte", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Delta", lines: [LINE_ZNAMY], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${LINE_ZNAMY.lineId}`);
  // Rovnaký obalový vzor ako `.ord-remark-cell`/`.ord-shop-remark-cell` — aj
  // ich testid sa overuje priamo, nielen odkaz/text vo vnútri.
  const bunka = within(riadok).getByTestId(`code-cell-${LINE_ZNAMY.lineId}`);
  const odkaz = within(bunka).getByRole<HTMLAnchorElement>("link", {
    name: `Otvoriť produkt ${LINE_ZNAMY.variantCode} na našom eshope`,
  });
  expect(odkaz.href).toBe(LINE_ZNAMY.ourUrl);
  expect(odkaz.target).toBe("_blank");
  expect(odkaz.rel).toBe("noreferrer noopener");
  expect(odkaz.textContent).toBe(LINE_ZNAMY.variantCode);
});

it("kód produktu, ktorý vo feede nepoznáme, sa zobrazí ako obyčajný text (nedá sa kliknúť)", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Delta", lines: [LINE_NEZNAMY], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${LINE_NEZNAMY.lineId}`);
  const bunka = within(riadok).getByTestId(`code-cell-${LINE_NEZNAMY.lineId}`);
  const text = within(bunka).getByTestId(`code-text-${LINE_NEZNAMY.lineId}`);
  expect(text.textContent).toBe(LINE_NEZNAMY.variantCode);
  expect(within(bunka).queryByRole("link", { name: `Otvoriť produkt ${LINE_NEZNAMY.variantCode} na našom eshope` })).toBeNull();
});
