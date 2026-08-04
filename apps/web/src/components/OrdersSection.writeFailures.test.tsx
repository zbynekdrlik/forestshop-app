import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// issue 66: dôkaz jadra ticketu — DVE NEZÁVISLÉ zlyhania (rôzne riadky, rôzne
// akcie) sa musia zobraziť SÚČASNE (predtým jediný `stateError` string druhé
// zlyhanie ÚPLNE prepísalo, prvé zmizlo z obrazovky, hoci sa nikdy neuložilo).
// Vlastný súbor — rovnaký vzor ako existujúce `OrdersSection.ordered.test
// .tsx`/`OrdersSection.assignSupplier.test.tsx` splity (`.claude/rules/
// testing.md`), aby žiadny súbor nenarástol cez eslint `max-lines: 400`.

const { fetchOpenOrders, fetchOrdersOverview, updateOrderLineState, updateOrderLineOrdered } = vi.hoisted(() => ({
  fetchOpenOrders: vi.fn(), fetchOrdersOverview: vi.fn(),
  updateOrderLineState: vi.fn(),
  updateOrderLineOrdered: vi.fn(),
}));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchOpenOrders,
    fetchOrdersOverview, updateOrderLineState, updateOrderLineOrdered };
});

const LINE_ALFA = {
  lineId: "11111111-1111-1111-1111-111111111111",
  orderId: "aaaaaaaa-1111-1111-1111-111111111111",
  externalOrderId: "1001",
  customerName: "Zákazník Alfa",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=1001&src=orders",
  placedAt: "2026-07-01T00:00:00.000Z",
  variantCode: "A-1",
  variantName: "Nohavice FOREST",
  sizeLabel: "3XL",
  quantity: 2,
  state: "objednane" as const,
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: false,
  manualSupplierOverride: null,
};

const LINE_BETA = {
  ...LINE_ALFA,
  lineId: "22222222-2222-2222-2222-222222222222",
  orderId: "bbbbbbbb-2222-2222-2222-222222222222",
  externalOrderId: "1002",
  customerName: "Zákazník Beta",
  variantCode: "B-1",
};

beforeEach(() => {
  fetchOrdersOverview.mockResolvedValue({ today: { orderCount: 0, revenue: "0.00" }, week: { orderCount: 0, revenue: "0.00" }, month: { orderCount: 0, revenue: "0.00" } });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("dve nezávislé zlyhania zápisu (iný riadok, iná akcia) sa zobrazia SÚČASNE, kumulatívne", async () => {
  fetchOpenOrders.mockResolvedValue([
    { supplier: "Dodávateľ Alfa", lines: [LINE_ALFA, LINE_BETA], email: null },
  ]);
  updateOrderLineState.mockRejectedValue(new Error("chyba stavu"));
  updateOrderLineOrdered.mockRejectedValue(new Error("chyba príznaku"));

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  // issue 161: `<select>` nahradili 4 tlačidlá — `state-select-<lineId>` je
  // teraz `role="radiogroup"` obal, konkrétny stav sa mení klikom na
  // `state-btn-<hodnota>-<lineId>`.
  await screen.findByTestId(`state-select-${LINE_ALFA.lineId}`);
  fireEvent.click(screen.getByTestId(`state-btn-skladom-${LINE_ALFA.lineId}`));

  await waitFor(() => {
    expect(screen.getByTestId("order-write-failures").textContent).toContain("Nepodarilo sa uložiť 1 položku");
  });

  const checkbox = screen.getByTestId<HTMLInputElement>(`ordered-checkbox-${LINE_BETA.lineId}`);
  fireEvent.click(checkbox);

  // OBE zlyhania viditeľné naraz — presne to, čo predtým chýbalo.
  await waitFor(() => {
    expect(screen.getByTestId("order-write-failures").textContent).toContain("Nepodarilo sa uložiť 2 položky");
  });
  expect(screen.getByTestId(`order-write-failure-state:${LINE_ALFA.lineId}`).textContent).toBe(
    "Zmena stavu — obj. 1001, kód A-1 (chyba stavu)",
  );
  expect(screen.getByTestId(`order-write-failure-ordered:${LINE_BETA.lineId}`).textContent).toBe(
    "Príznak objednané — obj. 1002, kód B-1 (chyba príznaku)",
  );
  // Zamietnutá zmena sa NIKDY netvári ako uložená.
  expect(screen.getByTestId(`state-btn-objednane-${LINE_ALFA.lineId}`).getAttribute("aria-checked")).toBe("true");
  expect(checkbox.checked).toBe(false);

  // Úspešný opakovaný zápis (riadok Alfa) zmaže LEN jeho položku — druhá
  // (Beta) ostáva viditeľná (legacy `clearToOrderFail`: "drop only ITS line").
  updateOrderLineState.mockResolvedValue(undefined);
  fireEvent.click(screen.getByTestId(`state-btn-skladom-${LINE_ALFA.lineId}`));

  await waitFor(() => {
    expect(screen.getByTestId("order-write-failures").textContent).toContain("Nepodarilo sa uložiť 1 položku");
  });
  expect(screen.queryByTestId(`order-write-failure-state:${LINE_ALFA.lineId}`)).toBeNull();
  expect(screen.getByTestId(`order-write-failure-ordered:${LINE_BETA.lineId}`)).toBeTruthy();

  // Zatvorenie bannera zmaže VŠETKY zostávajúce položky naraz.
  fireEvent.click(screen.getByRole("button", { name: "Zavrieť hlásenie o neuložených zmenách" }));
  expect(screen.queryByTestId("order-write-failures")).toBeNull();
});
