import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// issue 500: @ tlačidlo na riadku „Na objednanie" otvorí okno na ručný e-mail
// zákazníkovi (zdieľané jadro `useCustomerContactMail`). Mockujú sa len
// dvojkrokové API funkcie (náhľad → odoslanie) + načítanie zoznamu/prehľadu.
const { fetchOpenOrders, fetchOrdersOverview, fetchCustomerContactPreview, sendCustomerContactMail } = vi.hoisted(() => ({
  fetchOpenOrders: vi.fn(),
  fetchOrdersOverview: vi.fn(),
  fetchCustomerContactPreview: vi.fn(),
  sendCustomerContactMail: vi.fn(),
}));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return {
    ...actual,
    fetchOpenOrders,
    fetchOrdersOverview,
    fetchCustomerContactPreview,
    sendCustomerContactMail,
  };
});

const LINE_STARA = {
  lineId: "11111111-1111-1111-1111-111111111111",
  orderId: "aaaaaaaa-1111-1111-1111-111111111111",
  externalOrderId: "1001",
  customerName: "Zákazník Starý",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=1001&src=orders",
  placedAt: "2026-07-01T00:00:00.000Z",
  variantCode: "A-1",
  variantName: "Nohavice FOREST 1003",
  sizeLabel: "3XL",
  quantity: 2,
  state: "objednane" as const,
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: false,
  manualSupplierOverride: null,
  customerOpenOrderCount: 1,
  ourUrl: null,
};

const PREVIEW = {
  ok: true as const,
  subject: "Vaša objednávka č. 1001 — Forestshop.sk",
  html: "<p>...</p>",
  text: [
    "Dobrý deň, Zákazník Starý,",
    "",
    "Radi by sme Vás kontaktovali ohľadom Vašej objednávky č. 1001.",
    "",
    "S pozdravom,",
    "Drlík, Forestshop.sk",
  ].join("\n"),
  recipient: "zakaznik@example.sk",
  customerName: "Zákazník Starý",
  previewToken: "tok-123",
};

beforeEach(() => {
  fetchOrdersOverview.mockResolvedValue({
    today: { orderCount: 0, revenue: "0.00" },
    week: { orderCount: 0, revenue: "0.00" },
    month: { orderCount: 0, revenue: "0.00" },
  });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("klik @ otvorí okno predvyplnené menom + číslom objednávky, potvrdenie odošle presne ten text", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);
  fetchCustomerContactPreview.mockResolvedValue(PREVIEW);
  sendCustomerContactMail.mockResolvedValue({ ok: true });

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const atBtn = await screen.findByTestId(`customer-contact-open-${LINE_STARA.lineId}`);
  fireEvent.click(atBtn);

  // Náhľad sa pýta podľa ČÍSLA objednávky (externalOrderId), nie lineId.
  await waitFor(() => {
    expect(fetchCustomerContactPreview).toHaveBeenCalledWith("1001");
  });

  const dialog = await screen.findByTestId("customer-contact-preview");
  expect(dialog.textContent).toContain("zakaznik@example.sk");
  // issue 277: telo je kontrolovaná `<textarea>` — hodnotu treba čítať cez
  // `.value`, nikdy `textContent` (React nastavuje `.value` ako DOM vlastnosť).
  const body = screen.getByTestId<HTMLTextAreaElement>("customer-contact-preview-body");
  expect(body.value).toContain("Zákazník Starý");
  expect(body.value).toContain("1001");

  fireEvent.click(screen.getByTestId("customer-contact-preview-confirm"));

  await waitFor(() => {
    expect(sendCustomerContactMail).toHaveBeenCalledWith("1001", "tok-123", expect.stringContaining("Zákazník Starý"));
  });
  await waitFor(() => {
    expect(screen.queryByTestId("customer-contact-preview")).toBeNull();
  });
});

it("pri role bez oprávnenia zmien (citanie) sa @ tlačidlo vôbec nevykreslí", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);

  render(<OrdersSection role="citanie" onSessionExpired={() => {}} />);

  await screen.findByTestId(`order-line-${LINE_STARA.lineId}`);
  expect(screen.queryByTestId(`customer-contact-open-${LINE_STARA.lineId}`)).toBeNull();
});
