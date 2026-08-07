import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReturnedOrdersSection } from "./ReturnedOrdersSection.js";

const { fetchReturnedOrders } = vi.hoisted(() => ({ fetchReturnedOrders: vi.fn() }));

vi.mock("../orderFlagsApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../orderFlagsApi.js")>();
  return { ...actual, fetchReturnedOrders };
});

const { OrderFlagsUnauthorizedError } = await import("../orderFlagsApi.js");

const ROW = {
  id: "order-2",
  externalOrderId: "20600002",
  customerName: "Zákazník testovaný",
  statusName: "Vratený tovar",
  placedAt: "2026-08-01T10:00:00.000Z",
  totalPriceWithVat: null,
  comment: null,
  adminUrl: "https://www.forestshop.sk/admin/objednavky-detail/?id=2",
  unresolved: true,
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("prázdny zoznam zobrazí informačnú vetu", async () => {
  fetchReturnedOrders.mockResolvedValue([]);
  render(<ReturnedOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("returned-empty");
});

it("zobrazí objednávku, chýbajúca suma/poznámka sa ukáže ako pomlčka", async () => {
  fetchReturnedOrders.mockResolvedValue([ROW]);
  render(<ReturnedOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  const row = await screen.findByTestId("returned-row-20600002");
  expect(row.textContent).toContain("Vratený tovar");
  expect(row.textContent).toContain("—");
});

it("401 (Unauthorized) volá onSessionExpired", async () => {
  fetchReturnedOrders.mockRejectedValue(new OrderFlagsUnauthorizedError());
  const onSessionExpired = vi.fn();
  render(<ReturnedOrdersSection role="manazer" onSessionExpired={onSessionExpired} />);
  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalled();
  });
});
