import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// issue 111 bod 4: `.ord-remark-cell` predtým VŽDY vykresľovala holú
// pomlčku "—", keď objednávka nemá poznámku e-shopu (100 % dnešných ostrých
// dát) — presne ten istý zbytočný riadok navyše, aký #107 bod 3 už
// odstránilo zo susednej bunky priradenia dodávateľa. Vlastný súbor — rovnaký
// vzor ako `OrderLineRow.supplierAssignCell.test.tsx`
// (`.claude/rules/frontend-design.md`).
const { fetchOpenOrders } = vi.hoisted(() => ({ fetchOpenOrders: vi.fn() }));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchOpenOrders };
});

const ZAKLAD = {
  orderId: "cccccccc-1111-0000-0000-000000000000",
  externalOrderId: "20261400",
  customerName: "Zákazník Epsilon",
  comment: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=20261400&src=orders",
  placedAt: "2026-07-01T00:00:00.000Z",
  variantCode: "E-1",
  variantName: "Čiapka FOREST 5001",
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

const RIADOK_BEZ_POZNAMKY = {
  ...ZAKLAD,
  lineId: "22222222-1111-0000-0000-000000000001",
  remark: null,
};

const RIADOK_S_POZNAMKOU = {
  ...ZAKLAD,
  lineId: "22222222-1111-0000-0000-000000000002",
  externalOrderId: "20261401",
  remark: "Zavolať pred doručením",
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("riadok bez poznámky e-shopu nevykreslí žiadnu pomlčku v bunke poznámok", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Epsilon", lines: [RIADOK_BEZ_POZNAMKY], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${RIADOK_BEZ_POZNAMKY.lineId}`);
  const bunka = within(riadok).getByTestId(`remark-cell-${RIADOK_BEZ_POZNAMKY.lineId}`);
  expect(bunka.textContent).toBe("");
});

it("riadok S poznámkou e-shopu vykreslí jej text", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Epsilon", lines: [RIADOK_S_POZNAMKOU], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${RIADOK_S_POZNAMKOU.lineId}`);
  const bunka = within(riadok).getByTestId(`remark-cell-${RIADOK_S_POZNAMKOU.lineId}`);
  expect(bunka.textContent).toContain(RIADOK_S_POZNAMKOU.remark);
});
