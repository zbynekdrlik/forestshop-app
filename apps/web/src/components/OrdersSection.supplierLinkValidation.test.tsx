import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// issue 153: OKAMŽITÁ kontrola odkazu v prehliadači — PRED akýmkoľvek
// zápisom na server. Vlastný súbor — rovnaký vzor ako existujúce
// `OrdersSection.writeFailures.test.tsx`/`OrdersSection.assignSupplier.test
// .tsx` splity (`.claude/rules/testing.md`).

const { fetchOpenOrders, setProductSupplierLink } = vi.hoisted(() => ({
  fetchOpenOrders: vi.fn(),
  setProductSupplierLink: vi.fn(),
}));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchOpenOrders, setProductSupplierLink };
});

const LINE_ALFA = {
  lineId: "11111111-1111-1111-1111-111111111111",
  orderId: "aaaaaaaa-1111-1111-1111-111111111111",
  externalOrderId: "1001",
  customerName: "Zákazník Alfa",
  comment: null,
  remark: null,
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

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("neplatný odkaz na dodávateľa sa odmietne OKAMŽITE v prehliadači — bez volania API", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_ALFA], email: null }]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const toggle = await screen.findByTestId(`supplier-link-edit-toggle-${LINE_ALFA.lineId}`);
  fireEvent.click(toggle);
  const input = screen.getByTestId(`supplier-link-edit-input-${LINE_ALFA.lineId}`);
  fireEvent.change(input, { target: { value: "nieje-url" } });
  fireEvent.click(screen.getByTestId(`supplier-link-edit-save-${LINE_ALFA.lineId}`));

  await waitFor(() => {
    expect(screen.getByTestId(`order-write-failure-supplierLink:${LINE_ALFA.lineId}`).textContent).toBe(
      "Odkaz na dodávateľa — obj. 1001, kód A-1 (Odkaz musí byť platná adresa začínajúca http:// alebo https://.)",
    );
  });
  expect(setProductSupplierLink).not.toHaveBeenCalled();
});
