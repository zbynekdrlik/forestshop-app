import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// issue 259 — majiteľ (verbatim): "červenou to, čo už mám urobené, zelenou
// to, čo treba vybaviť". Binárne podľa kanonického `isLineResolved`
// (`ordersSummary.ts`), nie podľa jednotlivého `state` — pozri `app.css`'s
// `.line-resolved`/`.line-unresolved` komentár. Vlastný súbor, rovnaký vzor
// ako `OrderLineRow.adminLink.test.tsx` (`.claude/rules/frontend-design.md`).
const { fetchOpenOrders, fetchOrdersOverview } = vi.hoisted(() => ({ fetchOpenOrders: vi.fn(), fetchOrdersOverview: vi.fn() }));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchOpenOrders, fetchOrdersOverview };
});

const LINE = {
  lineId: "66666666-6666-6666-6666-666666666666",
  orderId: "dddddddd-6666-6666-6666-666666666666",
  externalOrderId: "20261300",
  customerName: "Zákazník Delta",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=20261300&src=orders",
  placedAt: "2026-07-01T00:00:00.000Z",
  variantCode: "D-1",
  variantName: "Čelovka FOREST 4001",
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

it("nevybavený riadok (predvolený stav, neodškrtnuté) dostane 'line-unresolved', nie 'line-resolved'", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Delta", lines: [LINE], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${LINE.lineId}`);
  expect(riadok.className).toContain("line-unresolved");
  expect(riadok.className).not.toContain("line-resolved");
});

it("riadok vybavený ODŠKRTNUTÍM 'objednané' (state stále predvolený) dostane 'line-resolved'", async () => {
  const ODSKRTNUTY = { ...LINE, lineId: "77777777-7777-7777-7777-777777777777", ordered: true };
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Delta", lines: [ODSKRTNUTY], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${ODSKRTNUTY.lineId}`);
  expect(riadok.className).toContain("line-resolved");
  expect(riadok.className).not.toContain("line-unresolved");
});

it("riadok vybavený POSUNUTÝM stavom (napr. 'skladom', neodškrtnutý) tiež dostane 'line-resolved'", async () => {
  const SKLADOM = { ...LINE, lineId: "88888888-8888-8888-8888-888888888888", state: "skladom" as const };
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Delta", lines: [SKLADOM], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${SKLADOM.lineId}`);
  expect(riadok.className).toContain("line-resolved");
});

// Farbosleposť: farba NIKDY nie je jediný signál — stĺpec "Stav" ukazuje
// odlišný TEXT bez ohľadu na farbu (`.claude/rules/frontend-design.md`).
it("farebné odlíšenie nie je jediný signál — textový štítok stavu ostáva viditeľný", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Delta", lines: [LINE], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${LINE.lineId}`);
  expect(riadok.textContent).toContain("Nevybavené");
});
