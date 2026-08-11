import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FloorOrdersSection } from "./FloorOrdersSection.js";

const { fetchFloorOrders } = vi.hoisted(() => ({ fetchFloorOrders: vi.fn() }));
vi.mock("../floorOrdersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../floorOrdersApi.js")>();
  return { ...actual, fetchFloorOrders };
});

const { FloorOrdersUnauthorizedError } = await import("../floorOrdersApi.js");

function row(externalOrderId: string): {
  id: string;
  externalOrderId: string;
  customerName: string;
  statusName: string;
  placedAt: string;
  totalPriceWithVat: string | null;
  adminUrl: string;
} {
  return {
    id: `order-${externalOrderId}`,
    externalOrderId,
    customerName: "Zákazník testovaný",
    statusName: "Vybavená",
    placedAt: "2026-08-01T10:00:00.000Z",
    totalPriceWithVat: "42.00",
    adminUrl: `https://www.forestshop.sk/admin/objednavky-detail/?id=${externalOrderId}`,
  };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("prázdny zoznam zobrazí informačnú vetu", async () => {
  fetchFloorOrders.mockResolvedValue({ total: 0, items: [] });
  render(<FloorOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("floor-orders-empty");
});

it("zobrazí riadok objednávky s odkazom do Shoptetu", async () => {
  fetchFloorOrders.mockResolvedValue({ total: 1, items: [row("93001")] });
  render(<FloorOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  const r = await screen.findByTestId("floor-order-row-93001");
  expect(r.textContent).toContain("93001");
  expect(r.textContent).toContain("42.00 €");
  expect(screen.getByTestId("floor-order-admin-link-93001").getAttribute("href")).toBe(
    "https://www.forestshop.sk/admin/objednavky-detail/?id=93001",
  );
});

// review finding (issue 345): keď POČIATOČNÉ načítanie zlyhá, `total` je
// tiež 0 — bez `error === ""` gate by sa "žiadna objednávka" zobrazilo
// popri chybovej hláške, hoci v skutočnosti sa nič nenačítalo.
it("keď počiatočné načítanie zlyhá, ukáže chybu, NIKDY prázdny stav 'žiadna objednávka'", async () => {
  fetchFloorOrders.mockRejectedValue(new Error("boom"));
  render(<FloorOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByRole("alert");
  expect(screen.queryByTestId("floor-orders-empty")).toBeNull();
});

it("401 (Unauthorized) volá onSessionExpired namiesto zobrazenia chyby", async () => {
  fetchFloorOrders.mockRejectedValue(new FloorOrdersUnauthorizedError());
  const onSessionExpired = vi.fn();
  render(<FloorOrdersSection role="manazer" onSessionExpired={onSessionExpired} />);
  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalled();
  });
});

it("keď je total väčší než počet zobrazených položiek, ukáže tlačidlo 'Načítať ďalšie' s počtom zvyšných", async () => {
  fetchFloorOrders.mockResolvedValue({ total: 11, items: [row("93001")] });
  render(<FloorOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  const button = await screen.findByTestId("load-more");
  expect(button.textContent).toBe("Načítať ďalšie (10)"); // min(PAGE_SIZE, 11 - 1)
});

it("klik na 'Načítať ďalšie' pripojí druhú stranu k existujúcim položkám, tlačidlo zmizne keď je zobrazené všetko", async () => {
  fetchFloorOrders.mockResolvedValueOnce({ total: 2, items: [row("93001")] });
  fetchFloorOrders.mockResolvedValueOnce({ total: 2, items: [row("93002")] });

  render(<FloorOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  fireEvent.click(await screen.findByTestId("load-more"));

  await screen.findByTestId("floor-order-row-93002");
  // Pôvodná položka ostáva viditeľná — DRUHÁ strana sa PRIPOJILA, nenahradila.
  expect(screen.getByTestId("floor-order-row-93001")).toBeTruthy();
  expect(fetchFloorOrders).toHaveBeenLastCalledWith({ page: 2 });
  await waitFor(() => {
    expect(screen.queryByTestId("load-more")).toBeNull();
  });
});

// review finding (issue 345): chyba pri "Načítať ďalšie" (na rozdiel od
// počiatočného načítania) NESMIE zhodiť už zobrazenú tabuľku — `items`/
// `total` sa pri nej vôbec nemenia (`useLoadMore`'s `onError`).
it("chyba pri 'Načítať ďalšie' ukáže hlášku, ale existujúce riadky ostanú viditeľné", async () => {
  fetchFloorOrders.mockResolvedValueOnce({ total: 2, items: [row("93001")] });
  fetchFloorOrders.mockRejectedValueOnce(new Error("boom"));

  render(<FloorOrdersSection role="manazer" onSessionExpired={vi.fn()} />);
  fireEvent.click(await screen.findByTestId("load-more"));

  await screen.findByRole("alert");
  expect(screen.getByTestId("floor-order-row-93001")).toBeTruthy();
  expect(screen.queryByTestId("floor-orders-empty")).toBeNull();
});
