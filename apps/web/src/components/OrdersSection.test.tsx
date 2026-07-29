import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

const { fetchOpenOrders } = vi.hoisted(() => ({ fetchOpenOrders: vi.fn() }));

// `OrdersUnauthorizedError` ostáva SKUTOČNÁ trieda z reálneho modulu — rovnaký
// dôvod ako `SchedulerSection.test.tsx`'s `SchedulerUnauthorizedError`:
// `instanceof` v komponente musí fungovať aj v teste.
vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchOpenOrders };
});

const { OrdersUnauthorizedError } = await import("../ordersApi.js");

const LINE_STARA = {
  lineId: "11111111-1111-1111-1111-111111111111",
  orderId: "aaaaaaaa-1111-1111-1111-111111111111",
  externalOrderId: "1001",
  customerName: "Zákazník Starý",
  comment: null,
  placedAt: "2026-07-01T00:00:00.000Z",
  variantCode: "A-1",
  variantName: "Nohavice FOREST 1003",
  sizeLabel: "3XL",
  quantity: 2,
  state: "objednane" as const,
};

const LINE_NOVA = {
  lineId: "22222222-2222-2222-2222-222222222222",
  orderId: "bbbbbbbb-2222-2222-2222-222222222222",
  externalOrderId: "1002",
  customerName: "Zákazník Nový",
  comment: "Zavolať pred doručením",
  placedAt: "2026-07-15T00:00:00.000Z",
  variantCode: "B-1",
  variantName: "Bunda FOREST 2001",
  sizeLabel: null,
  quantity: 1,
  state: "skladom" as const,
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("keď zatiaľ nie sú žiadne otvorené objednávky, zobrazí informačnú vetu namiesto holej tabuľky", async () => {
  fetchOpenOrders.mockResolvedValue([]);

  render(<OrdersSection onSessionExpired={() => {}} />);

  await screen.findByTestId("orders-empty");
  expect(screen.queryByRole("table")).toBeNull();
});

it("zoskupí riadky podľa dodávateľa a zobrazí produkt, veľkosť, množstvo a stav", async () => {
  fetchOpenOrders.mockResolvedValue([
    { supplier: "Dodávateľ Alfa", lines: [LINE_NOVA, LINE_STARA] },
  ]);

  render(<OrdersSection onSessionExpired={() => {}} />);

  const skupina = await screen.findByTestId("supplier-Dodávateľ Alfa");
  expect(skupina.textContent).toContain("Dodávateľ Alfa");

  const novy = screen.getByTestId(`order-line-${LINE_NOVA.lineId}`);
  expect(novy.textContent).toContain("1002");
  expect(novy.textContent).toContain("Zákazník Nový");
  expect(novy.textContent).toContain("B-1");
  expect(novy.textContent).toContain("Bunda FOREST 2001");
  expect(novy.textContent).toContain("Skladom");
  expect(novy.textContent).toContain("Zavolať pred doručením");

  const stary = screen.getByTestId(`order-line-${LINE_STARA.lineId}`);
  expect(stary.textContent).toContain("3XL");
  expect(stary.textContent).toContain("Objednané");
});

it("chýbajúcu veľkosť a komentár zobrazí ako pomlčku", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_NOVA] }]);

  render(<OrdersSection onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${LINE_NOVA.lineId}`);
  // LINE_NOVA má sizeLabel: null — zobrazí sa pomlčka namiesto prázdneho políčka.
  expect(riadok.textContent).toContain("—");
});

it("pri 401 zavolá onSessionExpired namiesto zobrazenia všeobecnej chyby", async () => {
  fetchOpenOrders.mockRejectedValue(new OrdersUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<OrdersSection onSessionExpired={onSessionExpired} />);

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keď načítanie zlyhá inou chybou, zobrazí vlastnú slovenskú hlášku", async () => {
  fetchOpenOrders.mockRejectedValue(new Error("network"));

  render(<OrdersSection onSessionExpired={() => {}} />);

  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe("Otvorené objednávky sa nepodarilo načítať.");
  });
});
