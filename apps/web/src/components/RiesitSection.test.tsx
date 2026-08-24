import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RiesitBadgeRefreshContext } from "../riesitBadgeContext.js";
import { RiesitSection } from "./RiesitSection.js";
import type { OrderLine, SupplierOpenOrders } from "../ordersApi.js";

// issue 476/484: sekcia „Riešiť" znovupoužíva jadro OrdersSection
// (`useOrderLinesBoard`) — mockujeme LEN sieťové funkcie `ordersApi.js`,
// komponent aj pomocné hooky bežia naozaj (rovnaký vzor ako
// `OrdersSection.remainingCount.test.tsx`). Issue 484: obrazovka je PLOCHÝ
// zoznam objednávok (1 objednávka = 1 kompaktný riadok s rozrolovaním), už NIE
// skupiny po dodávateľoch.
const { fetchRiesitOrders, setOrderLinesRiesitByCode, updateOrderLineState } = vi.hoisted(() => ({
  fetchRiesitOrders: vi.fn(),
  setOrderLinesRiesitByCode: vi.fn(),
  updateOrderLineState: vi.fn(),
}));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchRiesitOrders, setOrderLinesRiesitByCode, updateOrderLineState };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ORDER_ID = "aaaaaaaa-1111-1111-1111-111111111476";

const LINE_RIESIT: OrderLine = {
  lineId: "11111111-1111-1111-1111-111111111476",
  orderId: ORDER_ID,
  externalOrderId: "7001",
  customerName: "Zákazník Riešiť",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=7001&src=orders",
  placedAt: "2026-08-01T00:00:00.000Z",
  variantCode: "R-1",
  variantName: "Produkt na riešenie",
  sizeLabel: null,
  ourUrl: null,
  quantity: 1,
  state: "riesit",
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: false,
  manualSupplierOverride: null,
  customerOpenOrderCount: 1,
};

// Druhý riadok TEJ ISTEJ objednávky u INÉHO dodávateľa (Štěpánov prípad:
// jedna objednávka, viac dodávateľov) — musí sa preskupiť do JEDNEJ objednávky.
const LINE_RIESIT_2: OrderLine = {
  ...LINE_RIESIT,
  lineId: "22222222-1111-1111-1111-111111111476",
  variantCode: "R-2",
  variantName: "Druhý produkt",
};

const GROUP: SupplierOpenOrders = { supplier: "DODAVATEL-RIESIT", lines: [LINE_RIESIT], email: null };
const GROUP_2: SupplierOpenOrders = { supplier: "INY-DODAVATEL", lines: [LINE_RIESIT_2], email: null };

function renderRiesit(refresh: () => void = () => {}): void {
  render(
    <RiesitBadgeRefreshContext.Provider value={{ refresh }}>
      <RiesitSection role="manazer" onSessionExpired={() => {}} />
    </RiesitBadgeRefreshContext.Provider>,
  );
}

it("nemá vlastný nadpis (Topbar ho renderuje za viditeľné záložky)", async () => {
  fetchRiesitOrders.mockResolvedValue([]);
  renderRiesit();
  await screen.findByTestId("riesit-empty");
  expect(screen.queryByRole("heading")).toBeNull();
});

it("1 objednávka = 1 kompaktný riadok (zbalený); rozrolovanie ukáže položkové riadky", async () => {
  fetchRiesitOrders.mockResolvedValue([GROUP]);
  renderRiesit();

  // Kompaktný riadok objednávky sa zobrazí: meno zákazníka + počet položiek.
  const compact = await screen.findByTestId("riesit-order-7001");
  expect(compact.textContent).toContain("Zákazník Riešiť");
  expect(screen.getByTestId("riesit-order-count-7001").textContent).toBe("1 položka");

  // Zbalený — plný položkový riadok NIE je vidieť.
  expect(screen.queryByTestId(`order-line-${LINE_RIESIT.lineId}`)).toBeNull();

  // Rozrolovanie → položkový riadok + aktívne tlačidlo „Riešiť".
  fireEvent.click(screen.getByTestId("riesit-order-toggle-7001"));
  const riadok = await screen.findByTestId(`order-line-${LINE_RIESIT.lineId}`);
  expect(riadok).toBeTruthy();
  expect(screen.getByTestId(`state-btn-riesit-${LINE_RIESIT.lineId}`).getAttribute("aria-checked")).toBe("true");
});

it("viac riadkov tej istej objednávky (naprieč dodávateľmi) sa preskupí do JEDNEJ objednávky (2 položky)", async () => {
  fetchRiesitOrders.mockResolvedValue([GROUP, GROUP_2]);
  renderRiesit();

  // Jediná objednávka, hoci riadky prišli z DVOCH dodávateľských skupín.
  await screen.findByTestId("riesit-order-7001");
  expect(screen.getAllByTestId("riesit-order-7001").length).toBe(1);
  expect(screen.getByTestId("riesit-order-count-7001").textContent).toBe("2 položky");

  // Rozrolovanie ukáže OBA položkové riadky.
  fireEvent.click(screen.getByTestId("riesit-order-toggle-7001"));
  expect(await screen.findByTestId(`order-line-${LINE_RIESIT.lineId}`)).toBeTruthy();
  expect(screen.getByTestId(`order-line-${LINE_RIESIT_2.lineId}`)).toBeTruthy();
});

it("rýchle pole: číslo objednávky → označí a refetchne + refreshne odznak", async () => {
  fetchRiesitOrders.mockResolvedValue([]);
  setOrderLinesRiesitByCode.mockResolvedValue({ lineCount: 2 });
  const refresh = vi.fn();
  renderRiesit(refresh);
  await screen.findByTestId("riesit-empty");
  fetchRiesitOrders.mockClear();

  const input = screen.getByTestId<HTMLInputElement>("riesit-quick-add-input");
  fireEvent.change(input, { target: { value: "7001" } });
  fireEvent.click(screen.getByTestId("riesit-quick-add-submit"));

  await waitFor(() => {
    expect(setOrderLinesRiesitByCode).toHaveBeenCalledWith("7001");
  });
  expect((await screen.findByTestId("riesit-quick-add-message")).textContent).toContain("7001");
  expect(fetchRiesitOrders).toHaveBeenCalled();
  expect(refresh).toHaveBeenCalled();
});

it("rýchle pole: neznáme číslo zobrazí serverovú chybu", async () => {
  fetchRiesitOrders.mockResolvedValue([]);
  setOrderLinesRiesitByCode.mockRejectedValue(new Error("Objednávka s číslom „9999\" sa nenašla."));
  renderRiesit();
  await screen.findByTestId("riesit-empty");

  const input = screen.getByTestId<HTMLInputElement>("riesit-quick-add-input");
  fireEvent.change(input, { target: { value: "9999" } });
  fireEvent.click(screen.getByTestId("riesit-quick-add-submit"));

  const err = await screen.findByTestId("riesit-quick-add-error");
  expect(err.textContent).toContain("nenašla");
});

it("vypnutie stavu Riešiť poslednej položky objednávku zo zoznamu zloží", async () => {
  fetchRiesitOrders.mockResolvedValue([GROUP]);
  updateOrderLineState.mockResolvedValue(undefined);
  const refresh = vi.fn();
  renderRiesit(refresh);

  // Rozroluj objednávku a prepni jej jediný riadok na „Skladom".
  fireEvent.click(await screen.findByTestId("riesit-order-toggle-7001"));
  fireEvent.click(await screen.findByTestId(`state-btn-skladom-${LINE_RIESIT.lineId}`));

  // Riadok opustil stav riesit → z boardu zmizne, a keďže bol POSLEDNÝ,
  // celá objednávka z plochého zoznamu vypadne.
  await waitFor(() => {
    expect(screen.queryByTestId("riesit-order-7001")).toBeNull();
  });
  expect(updateOrderLineState).toHaveBeenCalledWith(LINE_RIESIT.lineId, "skladom");
  expect(refresh).toHaveBeenCalled();
});
