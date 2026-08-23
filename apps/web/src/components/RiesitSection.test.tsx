import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RiesitBadgeRefreshContext } from "../riesitBadgeContext.js";
import { RiesitSection } from "./RiesitSection.js";
import type { OrderLine, SupplierOpenOrders } from "../ordersApi.js";

// issue 476: sekcia „Riešiť" znovupoužíva jadro OrdersSection
// (`useOrderLinesBoard`) — mockujeme LEN sieťové funkcie `ordersApi.js`,
// komponent aj pomocné hooky bežia naozaj (rovnaký vzor ako
// `OrdersSection.remainingCount.test.tsx`).
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

const LINE_RIESIT: OrderLine = {
  lineId: "11111111-1111-1111-1111-111111111476",
  orderId: "aaaaaaaa-1111-1111-1111-111111111476",
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

const GROUP: SupplierOpenOrders = {
  supplier: "DODAVATEL-RIESIT",
  lines: [LINE_RIESIT],
  email: null,
};

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

it("vykreslí riadky v stave riesit zoskupené po dodávateľoch", async () => {
  fetchRiesitOrders.mockResolvedValue([GROUP]);
  renderRiesit();
  expect(await screen.findByTestId(`order-line-${LINE_RIESIT.lineId}`)).toBeTruthy();
  // aktívne je tlačidlo „Riešiť" (radio) tohto riadku
  const riesitBtn = screen.getByTestId(`state-btn-riesit-${LINE_RIESIT.lineId}`);
  expect(riesitBtn.getAttribute("aria-checked")).toBe("true");
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
  // úspech → hláška, refetch zoznamu, refresh odznaku
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

it("zmena stavu na iný → riadok zo sekcie zmizne (keepOnlyState)", async () => {
  fetchRiesitOrders.mockResolvedValue([GROUP]);
  updateOrderLineState.mockResolvedValue(undefined);
  const refresh = vi.fn();
  renderRiesit(refresh);
  await screen.findByTestId(`order-line-${LINE_RIESIT.lineId}`);

  // klik na „Skladom" — riadok opustí stav riesit, teda z tejto sekcie zmizne
  fireEvent.click(screen.getByTestId(`state-btn-skladom-${LINE_RIESIT.lineId}`));

  await waitFor(() => {
    expect(screen.queryByTestId(`order-line-${LINE_RIESIT.lineId}`)).toBeNull();
  });
  expect(updateOrderLineState).toHaveBeenCalledWith(LINE_RIESIT.lineId, "skladom");
  expect(refresh).toHaveBeenCalled();
});
