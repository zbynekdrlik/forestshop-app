import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// issue 121: majiteľ, doslovne "ak na produkt nie je odkaz na dodavatela, tak
// tam ma byt moznost ho doplnit... pri kazdom produkte ma byt moznost upravit
// link". Vlastný súbor — rovnaký vzor ako `OrderLineRow.supplierAssignCell
// .test.tsx` (`.claude/rules/frontend-design.md`).
const { fetchOpenOrders, fetchOrdersOverview, setProductSupplierLink } = vi.hoisted(() => ({
  fetchOpenOrders: vi.fn(), fetchOrdersOverview: vi.fn(),
  setProductSupplierLink: vi.fn(),
}));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchOpenOrders,
    fetchOrdersOverview, setProductSupplierLink };
});

const ZAKLAD = {
  orderId: "cccccccc-0000-0000-0000-000000000000",
  externalOrderId: "20261400",
  customerName: "Zákazník Epsilon",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=20261400&src=orders",
  placedAt: "2026-07-01T00:00:00.000Z",
  variantCode: "E-1",
  variantName: "Šál FOREST 5001",
  sizeLabel: null,
  quantity: 1,
  state: "objednane" as const,
  ordered: false,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: false,
  manualSupplierOverride: null,
  customerOpenOrderCount: 1,
  ourUrl: null,
};

const RIADOK_BEZ_ODKAZU = { ...ZAKLAD, lineId: "11111111-0000-0000-0000-000000000010", supplierUrl: null };
const RIADOK_S_ODKAZOM = {
  ...ZAKLAD,
  lineId: "11111111-0000-0000-0000-000000000011",
  externalOrderId: "20261401",
  supplierUrl: "https://dodavatel.example.com/produkt",
};

beforeEach(() => {
  fetchOrdersOverview.mockResolvedValue({ today: { orderCount: 0, revenue: "0.00" }, week: { orderCount: 0, revenue: "0.00" }, month: { orderCount: 0, revenue: "0.00" } });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("riadok BEZ odkazu ponúka 'doplniť'; otvorenie zobrazí prázdny vstup", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [RIADOK_BEZ_ODKAZU], email: null }]);
  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${RIADOK_BEZ_ODKAZU.lineId}`);
  const toggle = within(riadok).getByLabelText(
    `Doplniť odkaz na dodávateľa — ${RIADOK_BEZ_ODKAZU.variantName} (${RIADOK_BEZ_ODKAZU.variantCode})`,
  );
  // issue 162: vstup teraz žije vo VLASTNOM rozbaľovacom riadku POD týmto
  // riadkom (`colSpan` cez celú tabuľku), nie ako potomok `riadok`u — nájde
  // sa cez `screen` (testid je jedinečný na `lineId`, žiadna kolízia v tomto
  // teste s jedným riadkom).
  expect(screen.queryByTestId(`supplier-link-edit-${RIADOK_BEZ_ODKAZU.lineId}`)).toBeNull();

  fireEvent.click(toggle);

  const vstup = screen.getByTestId<HTMLInputElement>(`supplier-link-edit-input-${RIADOK_BEZ_ODKAZU.lineId}`);
  expect(vstup.value).toBe("");
});

it("riadok S odkazom ponúka 'upraviť'; otvorenie predvyplní vstup AKTUÁLNYM odkazom", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [RIADOK_S_ODKAZOM], email: null }]);
  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${RIADOK_S_ODKAZOM.lineId}`);
  const toggle = within(riadok).getByLabelText(
    `Upraviť odkaz na dodávateľa — ${RIADOK_S_ODKAZOM.variantName} (${RIADOK_S_ODKAZOM.variantCode})`,
  );

  fireEvent.click(toggle);

  const vstup = screen.getByTestId<HTMLInputElement>(`supplier-link-edit-input-${RIADOK_S_ODKAZOM.lineId}`);
  expect(vstup.value).toBe(RIADOK_S_ODKAZOM.supplierUrl);
});

it("uloženie zavolá setProductSupplierLink so správnym lineId a URL, a zavrie panel", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [RIADOK_BEZ_ODKAZU], email: null }]);
  setProductSupplierLink.mockResolvedValue(undefined);
  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${RIADOK_BEZ_ODKAZU.lineId}`);
  fireEvent.click(
    within(riadok).getByLabelText(
      `Doplniť odkaz na dodávateľa — ${RIADOK_BEZ_ODKAZU.variantName} (${RIADOK_BEZ_ODKAZU.variantCode})`,
    ),
  );
  const vstup = screen.getByTestId<HTMLInputElement>(`supplier-link-edit-input-${RIADOK_BEZ_ODKAZU.lineId}`);
  fireEvent.change(vstup, { target: { value: "https://novy-dodavatel.example.com/x" } });
  expect(vstup.value).toBe("https://novy-dodavatel.example.com/x");
  fireEvent.click(screen.getByTestId(`supplier-link-edit-save-${RIADOK_BEZ_ODKAZU.lineId}`));

  await waitFor(() => {
    expect(setProductSupplierLink).toHaveBeenCalledWith(
      RIADOK_BEZ_ODKAZU.lineId,
      "https://novy-dodavatel.example.com/x",
    );
  });
  expect(screen.queryByTestId(`supplier-link-edit-${RIADOK_BEZ_ODKAZU.lineId}`)).toBeNull();
  // issue 121: PLNÝ refetch po úspechu (rovnaký dôvod ako priradenie
  // dodávateľa — zmena môže zasiahnuť súrodenecké veľkosti toho istého
  // produktu).
  await waitFor(() => {
    expect(fetchOpenOrders).toHaveBeenCalledTimes(2);
  });
});

it("zlyhanie uloženia zobrazí slovenskú hlášku", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [RIADOK_BEZ_ODKAZU], email: null }]);
  setProductSupplierLink.mockRejectedValue(new Error("Uloženie odkazu na dodávateľa sa nepodarilo"));
  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${RIADOK_BEZ_ODKAZU.lineId}`);
  fireEvent.click(
    within(riadok).getByLabelText(
      `Doplniť odkaz na dodávateľa — ${RIADOK_BEZ_ODKAZU.variantName} (${RIADOK_BEZ_ODKAZU.variantCode})`,
    ),
  );
  const vstup = screen.getByTestId<HTMLInputElement>(`supplier-link-edit-input-${RIADOK_BEZ_ODKAZU.lineId}`);
  fireEvent.change(vstup, { target: { value: "https://zly-odkaz.example.com" } });
  fireEvent.click(screen.getByTestId(`supplier-link-edit-save-${RIADOK_BEZ_ODKAZU.lineId}`));

  // issue 66: kumulatívny banner nahrádza pôvodný jediný `<p role="alert">`.
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe(
      "⚠️ Nepodarilo sa uložiť 1 položku×Odkaz na dodávateľa — obj. 20261400, kód E-1 (Uloženie odkazu na dodávateľa sa nepodarilo)",
    );
  });
});

it("kliknutie na toggle znova (zrušiť) zavrie panel bez volania API", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [RIADOK_BEZ_ODKAZU], email: null }]);
  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${RIADOK_BEZ_ODKAZU.lineId}`);
  const toggle = within(riadok).getByLabelText(
    `Doplniť odkaz na dodávateľa — ${RIADOK_BEZ_ODKAZU.variantName} (${RIADOK_BEZ_ODKAZU.variantCode})`,
  );
  fireEvent.click(toggle);
  expect(screen.queryByTestId(`supplier-link-edit-${RIADOK_BEZ_ODKAZU.lineId}`)).not.toBeNull();

  fireEvent.click(
    within(riadok).getByLabelText(
      `Zrušiť úpravu odkazu na dodávateľa — ${RIADOK_BEZ_ODKAZU.variantName} (${RIADOK_BEZ_ODKAZU.variantCode})`,
    ),
  );
  expect(screen.queryByTestId(`supplier-link-edit-${RIADOK_BEZ_ODKAZU.lineId}`)).toBeNull();
  expect(setProductSupplierLink).not.toHaveBeenCalled();
});

// issue 162 (code review finding): `OrderLineRow.tsx`'s `ORDERS_TABLE_COLUMN_
// COUNT` je RUČNE udržiavaná konštanta, ktorá musí sedieť s počtom <col> v
// `SupplierOrderGroup.tsx`'s <colgroup> — žiadny automatický zdroj pravdy.
// Bez tohto testu by budúca zmena počtu stĺpcov (pridanie/odstránenie <col>)
// bez aktualizácie konštanty prešla ticho — rozbaľovací riadok by len bol o
// stĺpec užší/širší než celá tabuľka, nič by nezlyhalo.
it("colSpan rozbaľovacieho riadku sedí s reálnym počtom <col> v <colgroup>", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [RIADOK_BEZ_ODKAZU], email: null }]);
  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId(`order-line-${RIADOK_BEZ_ODKAZU.lineId}`);
  fireEvent.click(
    within(riadok).getByLabelText(
      `Doplniť odkaz na dodávateľa — ${RIADOK_BEZ_ODKAZU.variantName} (${RIADOK_BEZ_ODKAZU.variantCode})`,
    ),
  );

  const skutocnyPocetStlpcov = document.querySelectorAll(".orders-table colgroup col").length;
  const rozbalovaciRiadokTd = screen.getByTestId(`supplier-link-edit-${RIADOK_BEZ_ODKAZU.lineId}`).closest("td");
  expect(rozbalovaciRiadokTd).not.toBeNull();
  expect((rozbalovaciRiadokTd as HTMLTableCellElement).colSpan).toBe(skutocnyPocetStlpcov);
});
