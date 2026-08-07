import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ClaimOrdersSection } from "./ClaimOrdersSection.js";

const { fetchClaimOrders, markOrderClaim, clearOrderClaim } = vi.hoisted(() => ({
  fetchClaimOrders: vi.fn(),
  markOrderClaim: vi.fn(),
  clearOrderClaim: vi.fn(),
}));

vi.mock("../orderFlagsApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../orderFlagsApi.js")>();
  return { ...actual, fetchClaimOrders, markOrderClaim, clearOrderClaim };
});

const CLAIM = {
  id: "order-3",
  externalOrderId: "20600003",
  customerName: "Zákazník testovaný",
  statusName: "Vybavená",
  placedAt: "2026-08-01T10:00:00.000Z",
  totalPriceWithVat: "10.00",
  comment: null,
  adminUrl: "https://www.forestshop.sk/admin/objednavky-detail/?id=3",
  unresolved: true,
  claimNote: "chybný zips",
  claimMarkedAt: "2026-08-02T10:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("prázdny zoznam zobrazí informačnú vetu", async () => {
  fetchClaimOrders.mockResolvedValue([]);
  render(<ClaimOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("claims-empty");
});

it("zobrazí označenú reklamáciu s poznámkou", async () => {
  fetchClaimOrders.mockResolvedValue([CLAIM]);
  render(<ClaimOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  const row = await screen.findByTestId("claim-row-20600003");
  expect(row.textContent).toContain("chybný zips");
});

it("manažér označí objednávku ako reklamáciu — formulár sa vyprázdni, zoznam sa obnoví", async () => {
  fetchClaimOrders.mockResolvedValueOnce([]).mockResolvedValueOnce([CLAIM]);
  markOrderClaim.mockResolvedValue({ ok: true, orderId: "order-3" });
  render(<ClaimOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("claims-empty");

  fireEvent.change(screen.getByTestId("claim-order-code"), { target: { value: "20600003" } });
  fireEvent.change(screen.getByTestId("claim-note-input"), { target: { value: "chybný zips" } });
  fireEvent.click(screen.getByTestId("claim-mark-submit"));

  await waitFor(() => {
    expect(markOrderClaim).toHaveBeenCalledWith("20600003", "chybný zips");
  });
  await screen.findByTestId("claim-row-20600003");
  expect(screen.getByTestId<HTMLInputElement>("claim-order-code").value).toBe("");
});

it("neexistujúce číslo objednávky ukáže chybu z odpovede, nič sa nezmení", async () => {
  fetchClaimOrders.mockResolvedValue([]);
  markOrderClaim.mockResolvedValue({ ok: false, error: "Objednávka s týmto číslom sa nenašla." });
  render(<ClaimOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("claims-empty");

  fireEvent.change(screen.getByTestId("claim-order-code"), { target: { value: "neexistuje" } });
  fireEvent.click(screen.getByTestId("claim-mark-submit"));

  await screen.findByText("Objednávka s týmto číslom sa nenašla.");
});

it("zrušenie reklamácie zavolá clearOrderClaim a obnoví zoznam", async () => {
  fetchClaimOrders.mockResolvedValueOnce([CLAIM]).mockResolvedValueOnce([]);
  clearOrderClaim.mockResolvedValue(undefined);
  render(<ClaimOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("claim-row-20600003");

  fireEvent.click(screen.getByTestId("claim-clear-20600003"));

  await waitFor(() => {
    expect(clearOrderClaim).toHaveBeenCalledWith("order-3");
  });
  await screen.findByTestId("claims-empty");
});

it("rola citanie NEVIDÍ formulár na označenie ani tlačidlo zrušenia", async () => {
  fetchClaimOrders.mockResolvedValue([CLAIM]);
  render(<ClaimOrdersSection role="citanie" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("claim-row-20600003");
  expect(screen.queryByTestId("claim-order-code")).toBeNull();
  expect(screen.queryByTestId("claim-clear-20600003")).toBeNull();
});
