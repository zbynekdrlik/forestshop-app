import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// issue 148 — vyňaté do vlastného súboru (rovnaký vzor ako existujúce
// `OrdersSection.ordered.test.tsx`/`OrdersSection.assignSupplier.test.tsx`
// splity, `.claude/rules/testing.md`). Overuje PRESNE tú istú perzistenciu,
// akú `hideResolved` (issue 61) už má, ale pre `selectedSupplier` —
// `hideResolved` nemá vlastný vitest test na localStorage vôbec (jediné
// pokrytie je `orders.spec.ts`'s e2e reload test), takže toto je prvý takýto
// unit test v tomto súbore — zámerne priamo cez skutočnú jsdom
// `window.localStorage`, nie mock, aby overil SKUTOČNÝ read/write cyklus.

const { fetchOpenOrders, fetchOrdersOverview } = vi.hoisted(() => ({ fetchOpenOrders: vi.fn(), fetchOrdersOverview: vi.fn() }));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchOpenOrders,
    fetchOrdersOverview };
});

const STORAGE_KEY = "forestshop.orders.selectedSupplier";

const LINE_ALFA = {
  lineId: "11111111-1111-1111-1111-111111111148",
  orderId: "aaaaaaaa-1111-1111-1111-111111111148",
  externalOrderId: "2001",
  customerName: "Zákazník Alfa",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=2001&src=orders",
  placedAt: "2026-07-01T00:00:00.000Z",
  variantCode: "P-1",
  variantName: "Produkt Alfa",
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

const LINE_BETA = { ...LINE_ALFA, lineId: "22222222-2222-2222-2222-222222222148", variantCode: "P-2" };

beforeEach(() => {
  fetchOrdersOverview.mockResolvedValue({ today: { orderCount: 0, revenue: "0.00" }, week: { orderCount: 0, revenue: "0.00" }, month: { orderCount: 0, revenue: "0.00" } });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  window.localStorage.clear();
});

it("vybraný dodávateľ prežije novú inštanciu appky (localStorage) — rovnaký chip je aktívny hneď po načítaní", async () => {
  fetchOpenOrders.mockResolvedValue([
    { supplier: "Dodávateľ Alfa", lines: [LINE_ALFA], email: null },
    { supplier: "Dodávateľ Beta", lines: [LINE_BETA], email: null },
  ]);

  const prveVykreslenie = render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);
  const chipBeta = await screen.findByTestId("supplier-chip-Dodávateľ Beta");
  fireEvent.click(chipBeta);
  expect(chipBeta.className).toContain("active");
  expect(window.localStorage.getItem(STORAGE_KEY)).toBe("Dodávateľ Beta");
  prveVykreslenie.unmount();

  // "Obnovenie stránky" = nová inštancia komponentu nad TOU ISTOU localStorage.
  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);
  const chipBetaPoObnoveni = await screen.findByTestId("supplier-chip-Dodávateľ Beta");
  await waitFor(() => {
    expect(chipBetaPoObnoveni.className).toContain("active");
  });
  expect(screen.getByTestId("supplier-chip-all").className).not.toContain("active");
});

it("keď dodávateľ z localStorage medzi PRÁVE načítanými skupinami už nefiguruje, výber spadne na 'Všetci'", async () => {
  window.localStorage.setItem(STORAGE_KEY, "Dodávateľ Zaniknutý");
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_ALFA], email: null }]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  await waitFor(() => {
    expect(screen.getByTestId("supplier-chip-all").className).toContain("active");
  });
  expect(screen.getByTestId("supplier-chip-Dodávateľ Alfa").className).not.toContain("active");
  expect(window.localStorage.getItem(STORAGE_KEY)).toBe("");
});
