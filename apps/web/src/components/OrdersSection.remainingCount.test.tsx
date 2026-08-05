import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useMemo, useState, type JSX } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { OrdersRemainingCountContext } from "../ordersRemainingCountContext.js";
import { OrdersSection } from "./OrdersSection.js";

// issue 147 — overuje, že `OrdersSection` PUBLIKUJE počet nevybavených
// riadkov do `OrdersRemainingCountContext` (spotrebiteľ v produkčnom kóde je
// `App.tsx`/`Sidebar.tsx`, tu ho nahrádza tenký testovací "harness", ktorý
// prečítanú hodnotu vypíše do DOM-u, aby sa dala assertovať).

const { fetchOpenOrders, updateOrderLineState } = vi.hoisted(() => ({
  fetchOpenOrders: vi.fn(),
  updateOrderLineState: vi.fn(),
}));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchOpenOrders, updateOrderLineState };
});

function Harness(): JSX.Element {
  const [count, setCount] = useState<number | null>(null);
  // `onSessionExpired` MUSÍ mať stabilnú identitu naprieč re-renderami tohto
  // harness-u (Harness sa znova vykreslí zakaždým, keď `OrdersSection`
  // zavolá `setCount`) — inak by nová `() => {}` funkcia pri každom
  // re-rendri zneplatnila `OrdersSection.tsx`'s `useCallback(load, …)` a
  // spôsobila ĎALŠÍ (zbytočný) `fetchOpenOrders` refetch, čo by tento test
  // hlásil ako falošný regresný nález namiesto skutočného správania appky.
  const onSessionExpired = useCallback(() => {}, []);
  const contextValue = useMemo(() => ({ count, setCount }), [count]);
  return (
    <OrdersRemainingCountContext.Provider value={contextValue}>
      <span data-testid="remaining-count">{count === null ? "null" : count}</span>
      <OrdersSection role="manazer" onSessionExpired={onSessionExpired} />
    </OrdersRemainingCountContext.Provider>
  );
}

const LINE_NEVYBAVENY = {
  lineId: "11111111-1111-1111-1111-111111111147",
  orderId: "aaaaaaaa-1111-1111-1111-111111111147",
  externalOrderId: "3001",
  customerName: "Zákazník Nevybavený",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=3001&src=orders",
  placedAt: "2026-07-01T00:00:00.000Z",
  variantCode: "N-1",
  variantName: "Produkt Nevybavený",
  sizeLabel: null,
  quantity: 1,
  state: "objednane" as const,
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: false,
  manualSupplierOverride: null,
  ourUrl: null,
};

const LINE_VYBAVENY = { ...LINE_NEVYBAVENY, lineId: "22222222-2222-2222-2222-222222222147", ordered: true };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("po načítaní publikuje počet nevybavených riadkov (nie celkový počet)", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_NEVYBAVENY, LINE_VYBAVENY], email: null }]);

  render(<Harness />);

  expect(screen.getByTestId("remaining-count").textContent).toBe("null");
  await waitFor(() => {
    expect(screen.getByTestId("remaining-count").textContent).toBe("1");
  });
});

it("po zmene stavu posledného nevybaveného riadku odznak klesne na 0, bez nového refetchu", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_NEVYBAVENY, LINE_VYBAVENY], email: null }]);
  updateOrderLineState.mockResolvedValue(undefined);

  render(<Harness />);
  await waitFor(() => {
    expect(screen.getByTestId("remaining-count").textContent).toBe("1");
  });

  // issue 161: `<select>` nahradili 4 tlačidlá.
  await screen.findByTestId(`state-select-${LINE_NEVYBAVENY.lineId}`);
  fireEvent.click(screen.getByTestId(`state-btn-skladom-${LINE_NEVYBAVENY.lineId}`));

  await waitFor(() => {
    expect(screen.getByTestId("remaining-count").textContent).toBe("0");
  });
  expect(fetchOpenOrders).toHaveBeenCalledTimes(1);
});
