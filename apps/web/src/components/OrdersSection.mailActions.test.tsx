import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrdersSection } from "./OrdersSection.js";

// issue 118: majiteľ, doslovne "📋 Kopírovať objednávku ✉️ Poslať objednávku
// e-mailom zatial skry este to nebudeme pouzivat" — appka tieto tlačidlá
// SKRÝVA (nemaže), `orderScreenFlags.ts`'s `SHOW_ORDER_MAIL_ACTIONS`
// (predvolene `false`, overuje `OrdersSection.test.tsx`). Tento súbor
// prepína flag na `true`, aby zostala funkcionalita (náhľad/odoslanie mailu,
// kopírovanie do schránky) plne otestovaná aj počas skrytia — presne testy,
// ktoré predtým žili v `OrdersSection.test.tsx` (rovnaký "same file split"
// vzor ako `OrdersSection.ordered.test.tsx`), len teraz s flagom natvrdo
// zapnutým.
vi.mock("./orderScreenFlags.js", () => ({ SHOW_ORDER_MAIL_ACTIONS: true }));

const { fetchOpenOrders, setSupplierEmail, fetchSupplierOrderMailPreview, sendSupplierOrderMail } = vi.hoisted(() => ({
  fetchOpenOrders: vi.fn(),
  setSupplierEmail: vi.fn(),
  fetchSupplierOrderMailPreview: vi.fn(),
  sendSupplierOrderMail: vi.fn(),
}));

vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return {
    ...actual,
    fetchOpenOrders,
    setSupplierEmail,
    fetchSupplierOrderMailPreview,
    sendSupplierOrderMail,
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
};

// Rovnaký riadok, ale vo stave "caka_sa" (vybavený, nie "objednane") —
// `outstandingState` v `SupplierActionsPanel.tsx` je `"objednane"`, takže
// skupina BEZ ani jedného takého riadku nemá čo poslať, aj keď má e-mail.
const LINE_VYBAVENA = { ...LINE_STARA, lineId: "22222222-1111-1111-1111-111111111111", state: "caka_sa" as const };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("s flagom zapnutým sa tlačidlá kopírovania/odoslania mailom vykresľujú (issue 118 ich len skrýva, nemaže)", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId(`order-line-${LINE_STARA.lineId}`);
  expect(screen.getByRole("button", { name: "✉️ Poslať objednávku e-mailom" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "📋 Kopírovať objednávku" })).toBeTruthy();
});

it("bez e-mailu je tlačidlo na odoslanie mailom disabled s vysvetlením", async () => {
  fetchOpenOrders.mockResolvedValue([{ supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: null }]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const tlacidlo = await screen.findByRole("button", { name: "✉️ Poslať objednávku e-mailom" });
  expect(tlacidlo.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Pre odoslanie mailom treba najprv nastaviť e-mail dodávateľa.")).toBeTruthy();
});

// Predtým overené len e2e (`orders.spec.ts`) — presunuté sem, keď e2e prestal
// vedieť kliknúť na (teraz skryté) tlačidlo naživo. Dokazuje, že disabled stav
// sleduje SKUTOČNÝ stav riadkov ("objednane"/nevybavené), nie len prítomnosť
// e-mailu — skupina s e-mailom, ale BEZ jediného nevybaveného riadku, musí
// ostať disabled.
it("s e-mailom, ale bez nevybaveného riadku, ostáva tlačidlo na odoslanie mailom disabled", async () => {
  fetchOpenOrders.mockResolvedValue([
    { supplier: "Dodávateľ Alfa", lines: [LINE_VYBAVENA], email: "alfa@dodavatel.example" },
  ]);

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const tlacidlo = await screen.findByRole("button", { name: "✉️ Poslať objednávku e-mailom" });
  expect(tlacidlo.hasAttribute("disabled")).toBe(true);
});

it("s e-mailom a otvorenou položkou manažér otvorí náhľad, potvrdí a mail sa odošle", async () => {
  fetchOpenOrders.mockResolvedValue([
    { supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: "alfa@dodavatel.example" },
  ]);
  fetchSupplierOrderMailPreview.mockResolvedValue({
    supplier: "Dodávateľ Alfa",
    to: "alfa@dodavatel.example",
    subject: "Objednávka — Dodávateľ Alfa (1 položka)",
    body: "Objednávka — Dodávateľ Alfa (1 položka)\nA-1 | 3XL | 2 ks",
    itemCount: 1,
  });
  sendSupplierOrderMail.mockResolvedValue({ ok: true });

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const posluTlacidlo = await screen.findByRole("button", { name: "✉️ Poslať objednávku e-mailom" });
  expect(posluTlacidlo.hasAttribute("disabled")).toBe(false);
  fireEvent.click(posluTlacidlo);

  await waitFor(() => {
    expect(fetchSupplierOrderMailPreview).toHaveBeenCalledWith("Dodávateľ Alfa");
  });
  const nahlad = await screen.findByTestId("mail-preview-Dodávateľ Alfa");
  expect(nahlad.textContent).toContain("alfa@dodavatel.example");
  expect(nahlad.textContent).toContain("Objednávka — Dodávateľ Alfa (1 položka)");

  fireEvent.click(screen.getByRole("button", { name: "Odoslať" }));

  await waitFor(() => {
    expect(sendSupplierOrderMail).toHaveBeenCalledWith("Dodávateľ Alfa");
  });
  await waitFor(() => {
    expect(screen.getByRole("status").textContent).toContain("odoslaná");
  });
  expect(screen.queryByTestId("mail-preview-Dodávateľ Alfa")).toBeNull();
});

it("kopírovanie objednávky do schránky použije text náhľadu", async () => {
  fetchOpenOrders.mockResolvedValue([
    { supplier: "Dodávateľ Alfa", lines: [LINE_STARA], email: "alfa@dodavatel.example" },
  ]);
  fetchSupplierOrderMailPreview.mockResolvedValue({
    supplier: "Dodávateľ Alfa",
    to: "alfa@dodavatel.example",
    subject: "Objednávka — Dodávateľ Alfa (1 položka)",
    body: "Objednávka — Dodávateľ Alfa (1 položka)\nA-1 | 3XL | 2 ks",
    itemCount: 1,
  });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });

  render(<OrdersSection role="manazer" onSessionExpired={() => {}} />);

  const kopirovat = await screen.findByRole("button", { name: "📋 Kopírovať objednávku" });
  fireEvent.click(kopirovat);

  await waitFor(() => {
    expect(writeText).toHaveBeenCalledWith("Objednávka — Dodávateľ Alfa (1 položka)\nA-1 | 3XL | 2 ks");
  });
  await waitFor(() => {
    expect(screen.getByRole("status").textContent).toContain("schránky");
  });
});
