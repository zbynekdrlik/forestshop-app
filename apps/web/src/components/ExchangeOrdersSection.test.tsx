import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExchangeOrdersSection } from "./ExchangeOrdersSection.js";

const { fetchExchangeOrders } = vi.hoisted(() => ({ fetchExchangeOrders: vi.fn() }));

vi.mock("../orderFlagsApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../orderFlagsApi.js")>();
  return { ...actual, fetchExchangeOrders };
});

const { OrderFlagsUnauthorizedError } = await import("../orderFlagsApi.js");

// issue 514: sekcia zobrazuje AKTÍVne výmeny (stav "Výmena tovaru"), nie
// hotové "Vybavená výmena". Štítok "nevybavené" (zdieľaný `OrderFlagTable`)
// ostáva funkčný pre zriedkavý prípad "Vratený tovar → Výmena tovaru" s
// lingering otvorenou vratenie kartou.
const ROW = {
  id: "order-1",
  externalOrderId: "20600001",
  customerName: "Zákazník testovaný",
  statusName: "Výmena tovaru",
  placedAt: "2026-08-01T10:00:00.000Z",
  totalPriceWithVat: "42.00",
  comment: "poznámka",
  adminUrl: "https://www.forestshop.sk/admin/objednavky-detail/?id=1",
  unresolved: false,
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

it("hlavička popisuje aktívne výmeny (issue 514)", async () => {
  fetchExchangeOrders.mockResolvedValue([]);
  const { container } = render(<ExchangeOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("exchange-empty");
  expect(container.textContent).toContain("Výmena tovaru");
  expect(container.textContent).toContain("aktívne výmeny");
});

it("zobrazí riadok aktívnej výmeny (stav 'Výmena tovaru') s odkazom", async () => {
  fetchExchangeOrders.mockResolvedValue([ROW]);
  render(<ExchangeOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  const row = await screen.findByTestId("exchange-row-20600001");
  expect(row.textContent).toContain("20600001");
  expect(row.textContent).toContain("Výmena tovaru");
  expect(screen.queryByTestId("exchange-row-unresolved-20600001")).toBeNull();
});

it("štítok 'nevybavené' sa zobrazí pri lingering otvorenej vratenie karte (Vratený tovar → Výmena tovaru)", async () => {
  fetchExchangeOrders.mockResolvedValue([{ ...ROW, unresolved: true }]);
  render(<ExchangeOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("exchange-row-20600001");
  await screen.findByTestId("exchange-row-unresolved-20600001");
});

it("401 (Unauthorized) volá onSessionExpired namiesto zobrazenia chyby", async () => {
  fetchExchangeOrders.mockRejectedValue(new OrderFlagsUnauthorizedError());
  const onSessionExpired = vi.fn();
  render(<ExchangeOrdersSection role="manazer" onSessionExpired={onSessionExpired} />);
  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalled();
  });
});
