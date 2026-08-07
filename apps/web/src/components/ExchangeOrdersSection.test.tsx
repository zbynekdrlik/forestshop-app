import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExchangeOrdersSection } from "./ExchangeOrdersSection.js";

const { fetchExchangeOrders } = vi.hoisted(() => ({ fetchExchangeOrders: vi.fn() }));

vi.mock("../orderFlagsApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../orderFlagsApi.js")>();
  return { ...actual, fetchExchangeOrders };
});

const { OrderFlagsUnauthorizedError } = await import("../orderFlagsApi.js");

const ROW = {
  id: "order-1",
  externalOrderId: "20600001",
  customerName: "Zákazník testovaný",
  statusName: "Vybavená výmena",
  placedAt: "2026-08-01T10:00:00.000Z",
  totalPriceWithVat: "42.00",
  comment: "poznámka",
  adminUrl: "https://www.forestshop.sk/admin/objednavky-detail/?id=1",
  unresolved: true,
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("prázdny zoznam zobrazí informačnú vetu", async () => {
  fetchExchangeOrders.mockResolvedValue([]);
  render(<ExchangeOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("exchange-empty");
});

it("zobrazí riadok objednávky s odkazom aj štítkom 'nevybavené', keď má otvorenú vratenie kartu", async () => {
  fetchExchangeOrders.mockResolvedValue([ROW]);
  render(<ExchangeOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  const row = await screen.findByTestId("exchange-row-20600001");
  expect(row.textContent).toContain("20600001");
  expect(row.textContent).toContain("Vybavená výmena");
  await screen.findByTestId("exchange-row-unresolved-20600001");
});

it("objednávka bez otvorenej karty NEMÁ štítok 'nevybavené'", async () => {
  fetchExchangeOrders.mockResolvedValue([{ ...ROW, unresolved: false }]);
  render(<ExchangeOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("exchange-row-20600001");
  expect(screen.queryByTestId("exchange-row-unresolved-20600001")).toBeNull();
});

it("401 (Unauthorized) volá onSessionExpired namiesto zobrazenia chyby", async () => {
  fetchExchangeOrders.mockRejectedValue(new OrderFlagsUnauthorizedError());
  const onSessionExpired = vi.fn();
  render(<ExchangeOrdersSection role="manazer" onSessionExpired={onSessionExpired} />);
  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalled();
  });
});
