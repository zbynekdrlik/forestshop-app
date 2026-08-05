import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// issue 107 bod 3: majiteľ, komentár #1: "neviem čo tam je Priradenie
// dodávateľa stĺpec" — každý riadok BEZ ohľadu na `supplierAssignable`
// predtým vykresľoval `.ord-supplier-assign` div, ktorý pri neradiťeľných
// riadkoch (100 % dnešných ostrých dát) ukazoval len holú pomlčku "—". Tento
// súbor dokazuje OBIDVE strany opravy: neradiťeľný riadok blok NEVYKRESLÍ
// vôbec (žiadny prvok v DOM), radiťeľný riadok ho vykreslí AJ s viditeľným
// popisom (nielen placeholderom). Vlastný súbor — rovnaký vzor ako
// `OrderLineRow.adminLink.test.tsx` (`.claude/rules/frontend-design.md`).
const { fetchOpenOrders, fetchOrdersOverview } = vi.hoisted(() => ({ fetchOpenOrders: vi.fn(), fetchOrdersOverview: vi.fn() }));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchOpenOrders,
    fetchOrdersOverview };
});

const ZAKLAD = {
  orderId: "cccccccc-0000-0000-0000-000000000000",
  externalOrderId: "20261300",
  customerName: "Zákazník Delta",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=20261300&src=orders",
  placedAt: "2026-07-01T00:00:00.000Z",
  variantCode: "D-1",
  variantName: "Šál FOREST 4001",
  sizeLabel: null,
  quantity: 1,
  state: "objednane" as const,
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  manualSupplierOverride: null,
  ourUrl: null,
};

const RIADOK_NERADITELNY = {
  ...ZAKLAD,
  lineId: "11111111-0000-0000-0000-000000000001",
  supplierAssignable: false,
};

const RIADOK_RADITELNY = {
  ...ZAKLAD,
  lineId: "11111111-0000-0000-0000-000000000002",
  externalOrderId: "20261301",
  supplierAssignable: true,
};

beforeEach(() => {
  fetchOrdersOverview.mockResolvedValue({ today: { orderCount: 0, revenue: "0.00" }, week: { orderCount: 0, revenue: "0.00" }, month: { orderCount: 0, revenue: "0.00" } });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("neradiťeľný riadok nevykreslí blok priradenia dodávateľa vôbec (žiadna pomlčka, žiadny prázdny div)", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "(bez dodávateľa)", lines: [RIADOK_NERADITELNY], email: null }]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${RIADOK_NERADITELNY.lineId}`);
  // Presne CIELENÁ neprítomnosť — `supplier-link-${lineId}` blok (odkaz/kód
  // dodávateľa, NEZÁVISLÝ od tohto ticketu) legitímne vykresľuje VLASTNÚ
  // pomlčku, keď riadok nemá ani odkaz, ani kód (`OrderLineRow.tsx:221`) —
  // preto sa tu neoveruje "žiadna pomlčka nikde v riadku", len skutočná
  // neprítomnosť TOHTO konkrétneho bloku.
  expect(within(riadok).queryByTestId(`supplier-assign-cell-${RIADOK_NERADITELNY.lineId}`)).toBeNull();
});

it("radiťeľný riadok vykreslí blok priradenia AJ s viditeľným popisom, nielen placeholderom", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "(bez dodávateľa)", lines: [RIADOK_RADITELNY], email: null }]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${RIADOK_RADITELNY.lineId}`);
  const blok = within(riadok).getByTestId(`supplier-assign-cell-${RIADOK_RADITELNY.lineId}`);
  // `getByLabelText`/`getByRole` už SAMY vyhodia, keď prvok nenájdu — žiadny
  // jest-dom matcher netreba (`.claude/rules/frontend-design.md`: tento
  // projekt nemá `@testing-library/jest-dom` zapojené).
  within(blok).getByLabelText(
    `Priradiť dodávateľa riadku objednávky ${RIADOK_RADITELNY.externalOrderId} / ${RIADOK_RADITELNY.variantCode}`,
  );
  within(blok).getByLabelText(
    `Uložiť priradenie dodávateľa riadku objednávky ${RIADOK_RADITELNY.externalOrderId} / ${RIADOK_RADITELNY.variantCode}`,
  );
  // Popis viditeľný AJ mimo placeholderu (dnes to prezrádza LEN placeholder)
  // — majiteľ, prvý komentár. Vykreslí sa v susednej `.ord-supplier-cell`
  // (nie priamo v `blok`u) — žiadny extra riadok výšky navyše, pozri
  // `OrderLineRow.tsx`'s komentár k `.ord-supplier-assign-hint`.
  expect(riadok.textContent).toContain("Priradiť dodávateľa");
});
