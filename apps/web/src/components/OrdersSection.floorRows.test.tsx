import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useMemo, useState, type JSX } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrdersRemainingCountContext } from "../ordersRemainingCountContext.js";
import { OrdersSection } from "./OrdersSection.js";

// issue 480: predajňové (floor) riadky v board-e „Na objednanie" — vykreslenie
// pod dodávateľom, per-item „objednané", počet v odznaku, hromadná akcia,
// filter „skryť vybavené", skupina LEN s predajňovými riadkami. Full-board
// integrácia cez `OrdersSection` (rovnaký vzor ako `OrdersSection.ordered.test
// .tsx`), mockujúci API vrstvu.

const { fetchOpenOrders, fetchOrdersOverview, setFloorRowOrdered, setSupplierLinesOrdered } = vi.hoisted(() => ({
  fetchOpenOrders: vi.fn(),
  fetchOrdersOverview: vi.fn(),
  setFloorRowOrdered: vi.fn(),
  setSupplierLinesOrdered: vi.fn(),
}));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchOpenOrders, fetchOrdersOverview, setFloorRowOrdered, setSupplierLinesOrdered };
});

const NOTE_ID = "note-1111-1111-1111-111111111111";

function floorRow(overrides: Record<string, unknown> = {}) {
  return {
    noteId: NOTE_ID,
    variantCode: "FLOOR-1",
    productName: "Čelovka FOREST",
    sizeLabel: null,
    customerName: "Jožko Predajňa",
    quantity: 2,
    createdAt: "2026-08-20T00:00:00.000Z",
    ordered: false,
    ...overrides,
  };
}

const ORDER_LINE = {
  lineId: "11111111-1111-1111-1111-111111111111",
  orderId: "aaaaaaaa-1111-1111-1111-111111111111",
  externalOrderId: "1001",
  customerName: "Zákazník E-shop",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=1001&src=orders",
  placedAt: "2026-07-01T00:00:00.000Z",
  variantCode: "A-1",
  variantName: "Nohavice FOREST",
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

const CHECKBOX = `floor-ordered-checkbox-${NOTE_ID}-FLOOR-1`;
const ROW = `floor-order-row-${NOTE_ID}-FLOOR-1`;

beforeEach(() => {
  fetchOrdersOverview.mockResolvedValue({ today: { orderCount: 0, revenue: "0.00" }, week: { orderCount: 0, revenue: "0.00" }, month: { orderCount: 0, revenue: "0.00" } });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  window.localStorage.clear();
});

it("predajňový riadok sa vykreslí pod svojím dodávateľom: 🛍️ odkaz, meno, produkt, kód, ks, checkbox", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [], floorRows: [floorRow()], email: null }]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const row = await screen.findByTestId(ROW);
  expect(row.textContent).toContain("Jožko Predajňa");
  expect(row.textContent).toContain("Čelovka FOREST");
  expect(row.textContent).toContain("2 ks");
  expect(screen.getByTestId(`floor-code-${NOTE_ID}-FLOOR-1`).textContent).toBe("FLOOR-1");
  // 🛍️ odkaz vedie na zápis v „Objednávky predajňa".
  const link = screen.getByTestId(`floor-order-link-${NOTE_ID}-FLOOR-1`);
  expect(link.getAttribute("href")).toBe("?tab=floor-orders");
  const checkbox = screen.getByTestId<HTMLInputElement>(CHECKBOX);
  expect(checkbox.checked).toBe(false);
  expect(checkbox.disabled).toBe(false);
});

it("rola citanie vidí predajňový checkbox needitovateľný", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [], floorRows: [floorRow()], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  const checkbox = await screen.findByTestId<HTMLInputElement>(CHECKBOX);
  expect(checkbox.disabled).toBe(true);
});

it("manažér odškrtne predajňový riadok — zavolá API a riadok sa vizuálne stlmí bez refetchu", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [], floorRows: [floorRow()], email: null }]);
  setFloorRowOrdered.mockResolvedValue(undefined);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const checkbox = await screen.findByTestId<HTMLInputElement>(CHECKBOX);
  fireEvent.click(checkbox);

  await waitFor(() => {
    expect(setFloorRowOrdered).toHaveBeenCalledWith(NOTE_ID, "FLOOR-1", true);
  });
  await waitFor(() => {
    expect(screen.getByTestId<HTMLInputElement>(CHECKBOX).checked).toBe(true);
  });
  expect(screen.getByTestId(ROW).className).toContain("ordered");
  expect(fetchOpenOrders).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("odznak Na objednanie počíta aj NEOBJEDNANÉ predajňové riadky", async () => {
  // 1 nevybavený order riadok + 2 predajňové riadky (jeden objednaný) → 1 + 1 = 2.
  fetchOpenOrders.mockResolvedValue([
    {
      supplier: "Dodávateľ Alfa",
      lines: [ORDER_LINE],
      floorRows: [floorRow(), floorRow({ variantCode: "FLOOR-2", ordered: true })],
      email: null,
    },
  ]);

  function Harness(): JSX.Element {
    const [count, setCount] = useState<number | null>(null);
    const onSessionExpired = useCallback(() => {}, []);
    const value = useMemo(() => ({ count, setCount }), [count]);
    return (
      <OrdersRemainingCountContext.Provider value={value}>
        <span data-testid="remaining-count">{count === null ? "null" : count}</span>
        <OrdersSection role="manazer" onSessionExpired={onSessionExpired} />
      </OrdersRemainingCountContext.Provider>
    );
  }

  render(<Harness />);

  await waitFor(() => {
    expect(screen.getByTestId("remaining-count").textContent).toBe("2");
  });
});

it("hromadné Označiť skupinu ako objednané zahŕňa aj predajňové riadky", async () => {
  fetchOpenOrders.mockResolvedValue([
    { supplier: "Dodávateľ Alfa", lines: [ORDER_LINE], floorRows: [floorRow()], email: null },
  ]);
  setSupplierLinesOrdered.mockResolvedValue({ lineCount: 1 });

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const oznacit = await screen.findByRole("button", { name: "✔ Označiť skupinu ako objednané" });
  fireEvent.click(oznacit);

  await waitFor(() => {
    expect(setSupplierLinesOrdered).toHaveBeenCalledWith("Dodávateľ Alfa", true);
  });
  // Predajňový riadok sa optimisticky prekreslí ako objednaný.
  await waitFor(() => {
    expect(screen.getByTestId<HTMLInputElement>(CHECKBOX).checked).toBe(true);
  });
  // Skupina je teraz celá objednaná (order riadok aj predajňový) — tlačidlo prepne smer.
  expect(await screen.findByRole("button", { name: "↺ Zrušiť označenie skupiny" })).toBeDefined();
});

it("skupina LEN s predajňovými riadkami (bez objednávok) sa vykreslí, nie prázdny stav", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Len Predajňa", lines: [], floorRows: [floorRow()], email: null }]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  expect(await screen.findByTestId(ROW)).toBeDefined();
  expect(screen.queryByTestId("orders-empty")).toBeNull();
  // Hlavička skupiny počíta predajňový riadok (nie „0 riadky").
  expect(screen.getByTestId("supplier-Len Predajňa").textContent).toContain("Len Predajňa — 1 riadok");
});

it("skryť vybavené skryje objednaný predajňový riadok", async () => {
  window.localStorage.setItem("forestshop.orders.hideResolved", "1");
  fetchOpenOrders.mockResolvedValue([
    { supplier: "Dodávateľ Alfa", lines: [], floorRows: [floorRow({ ordered: true })], email: null },
  ]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  // Skupina má len objednaný predajňový riadok → pri „skryť vybavené" sa
  // nevykreslí a zobrazí sa hláška „všetko vybavené".
  await waitFor(() => {
    expect(screen.getByTestId("orders-hidden-empty")).toBeDefined();
  });
  expect(screen.queryByTestId(ROW)).toBeNull();
});
