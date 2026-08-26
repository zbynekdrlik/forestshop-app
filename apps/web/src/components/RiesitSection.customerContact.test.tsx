import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RiesitBadgeRefreshContext } from "../riesitBadgeContext.js";
import { RiesitSection } from "./RiesitSection.js";
import type { OrderLine, SupplierOpenOrders } from "../ordersApi.js";

// issue 502: @ tlačidlo za menom zákazníka na riadku „Riešiť" otvorí to isté
// okno na e-mail zákazníkovi ako „Na objednanie" (#500) — zdieľané jadro
// `useCustomerContactMail`. Mockujú sa len sieťové funkcie `ordersApi.js`.
const { fetchRiesitOrders, fetchCustomerContactPreview, sendCustomerContactMail } = vi.hoisted(() => ({
  fetchRiesitOrders: vi.fn(),
  fetchCustomerContactPreview: vi.fn(),
  sendCustomerContactMail: vi.fn(),
}));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, fetchRiesitOrders, fetchCustomerContactPreview, sendCustomerContactMail };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const LINE_RIESIT: OrderLine = {
  lineId: "11111111-1111-1111-1111-111111111476",
  orderId: "aaaaaaaa-1111-1111-1111-111111111476",
  externalOrderId: "7001",
  customerName: "Zákazník Riešiť",
  comment: null,
  remark: null,
  shopRemark: null,
  adminUrl: "https://www.forestshop.sk/admin/vyhladavanie/?string=7001&src=orders",
  placedAt: "2026-08-01T00:00:00.000Z",
  variantCode: "R-1",
  variantName: "Produkt na riešenie",
  sizeLabel: null,
  ourUrl: null,
  quantity: 1,
  state: "riesit",
  ordered: false,
  supplierUrl: null,
  supplierNote: null,
  externalCode: null,
  supplierAssignable: false,
  manualSupplierOverride: null,
  customerOpenOrderCount: 1,
};

const GROUP: SupplierOpenOrders = { supplier: "DODAVATEL-RIESIT", lines: [LINE_RIESIT], email: null };

const PREVIEW = {
  ok: true as const,
  subject: "Vaša objednávka č. 7001 — Forestshop.sk",
  html: "<p>...</p>",
  text: [
    "Dobrý deň, Zákazník Riešiť,",
    "",
    "Radi by sme Vás kontaktovali ohľadom Vašej objednávky č. 7001.",
    "",
    "S pozdravom,",
    "Drlík, Forestshop.sk",
  ].join("\n"),
  recipient: "riesit@example.sk",
  customerName: "Zákazník Riešiť",
  previewToken: "tok700",
};

function renderRiesit(): void {
  render(
    <RiesitBadgeRefreshContext.Provider value={{ refresh: () => {} }}>
      <RiesitSection role="manazer" onSessionExpired={() => {}} />
    </RiesitBadgeRefreshContext.Provider>,
  );
}

it("klik @ na kompaktnom riadku Riešiť otvorí okno predvyplnené menom + číslom objednávky", async () => {
  fetchRiesitOrders.mockResolvedValue([GROUP]);
  fetchCustomerContactPreview.mockResolvedValue(PREVIEW);
  sendCustomerContactMail.mockResolvedValue({ ok: true });

  renderRiesit();

  // @ tlačidlo je na hlavičke riadku (testid podľa čísla objednávky), bez
  // potreby rozrolovania.
  const atBtn = await screen.findByTestId("customer-contact-open-7001");
  fireEvent.click(atBtn);

  await waitFor(() => {
    expect(fetchCustomerContactPreview).toHaveBeenCalledWith("7001");
  });

  const dialog = await screen.findByTestId("customer-contact-preview");
  expect(dialog.textContent).toContain("riesit@example.sk");
  const body = screen.getByTestId<HTMLTextAreaElement>("customer-contact-preview-body");
  expect(body.value).toContain("Zákazník Riešiť");
  expect(body.value).toContain("7001");

  fireEvent.click(screen.getByTestId("customer-contact-preview-confirm"));

  await waitFor(() => {
    expect(sendCustomerContactMail).toHaveBeenCalledWith("7001", "tok700", expect.stringContaining("Zákazník Riešiť"));
  });
  await waitFor(() => {
    expect(screen.queryByTestId("customer-contact-preview")).toBeNull();
  });
});
