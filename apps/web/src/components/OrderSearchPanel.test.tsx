import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrderSearchPanel } from "./OrderSearchPanel.js";

const { globalSearch } = vi.hoisted(() => ({ globalSearch: vi.fn() }));

// `SearchUnauthorizedError` ostáva SKUTOČNÁ trieda z reálneho modulu —
// rovnaký dôvod ako `SearchSection.test.tsx`: `instanceof` v komponente
// musí fungovať aj v teste.
vi.mock("../searchApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../searchApi.js")>();
  return { ...actual, globalSearch };
});

const { SearchUnauthorizedError } = await import("../searchApi.js");

const PRODUKT = {
  productKey: "PD-1",
  variantCode: "PD-1",
  productName: "Test produkt PD-1",
  sizeLabel: null,
  supplier: "Test dodávateľ",
  externalCode: "EXT-1",
  state: "sellable" as const,
};

const OBJEDNAVKA = {
  orderId: "order-1",
  externalOrderId: "9001",
  customerName: "Zákazník Alfa",
  email: "alfa@example.com",
  statusName: "Vybavuje sa",
  placedAt: "2026-07-01T10:00:00.000Z",
  adminUrl: "https://www.forestshop.sk/admin/objednavky-detail/?id=58728",
};

function submitOrderSearch(query: string): void {
  fireEvent.change(screen.getByLabelText("Objednávka"), { target: { value: query } });
  fireEvent.click(screen.getByRole("button", { name: "Hľadať objednávku" }));
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("renderuje popísané pole 'Objednávka'", () => {
  render(<OrderSearchPanel onSessionExpired={() => {}} />);
  expect(screen.getByLabelText("Objednávka")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Hľadať objednávku" })).toBeTruthy();
});

it("hľadanie čísla objednávky zavolá globalSearch a zobrazí nájdenú objednávku s odkazom do Shoptetu", async () => {
  globalSearch.mockResolvedValue({ products: [PRODUKT], orders: [OBJEDNAVKA] });

  render(<OrderSearchPanel onSessionExpired={() => {}} />);
  submitOrderSearch("9001");

  expect(globalSearch).toHaveBeenCalledWith("9001");
  const riadok = await screen.findByTestId("search-order-9001");
  expect(riadok.textContent).toContain("Zákazník Alfa");

  const odkaz = screen.getByTestId("search-order-admin-link-9001");
  expect(odkaz).toHaveProperty("href", "https://www.forestshop.sk/admin/objednavky-detail/?id=58728");
  // .products polovica odpovede sa v tomto paneli vôbec nevykresľuje.
  expect(screen.queryByTestId("search-products")).toBeNull();
});

it("neexistujúce číslo objednávky zobrazí informačnú vetu namiesto tabuľky", async () => {
  globalSearch.mockResolvedValue({ products: [], orders: [] });

  render(<OrderSearchPanel onSessionExpired={() => {}} />);
  submitOrderSearch("99999999");

  await screen.findByTestId("search-order-empty");
  expect(screen.queryByTestId("search-orders")).toBeNull();
});

it("prázdny dopyt zobrazí informačnú vetu, nie chybu", async () => {
  globalSearch.mockResolvedValue({ products: [], orders: [] });

  render(<OrderSearchPanel onSessionExpired={() => {}} />);
  submitOrderSearch("");

  await screen.findByTestId("search-order-empty");
});

it("pri 401 pri hľadaní objednávky zavolá onSessionExpired", async () => {
  globalSearch.mockRejectedValue(new SearchUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<OrderSearchPanel onSessionExpired={onSessionExpired} />);
  submitOrderSearch("9001");

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});

it("sieťová chyba zobrazí chybovú hlášku", async () => {
  globalSearch.mockRejectedValue(new Error("network down"));

  render(<OrderSearchPanel onSessionExpired={() => {}} />);
  submitOrderSearch("9001");

  await screen.findByText("Vyhľadávanie zlyhalo — server neodpovedal.");
});
