import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SupplierStockSection } from "./SupplierStockSection.js";

const { fetchSupplierStockStatus, runSupplierStockNow } = vi.hoisted(() => ({
  fetchSupplierStockStatus: vi.fn(),
  runSupplierStockNow: vi.fn(),
}));

// `SupplierStockUnauthorizedError` ostáva SKUTOČNÁ trieda — `instanceof`
// v komponente musí fungovať (rovnaký dôvod ako `NedostupneSection.test.tsx`).
vi.mock("../supplierStockApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../supplierStockApi.js")>();
  return { ...actual, fetchSupplierStockStatus, runSupplierStockNow };
});

const { SupplierStockUnauthorizedError } = await import("../supplierStockApi.js");

const STATUS = {
  overview: {
    total: 238,
    available: 120,
    unavailable: 90,
    unknown: 20,
    failed: 8,
    lastCheckedAt: "2026-08-03T04:20:00.000Z",
  },
  rows: [
    {
      link: "https://huntingshop.eu/bunda",
      host: "huntingshop.eu",
      availability: "available" as const,
      availabilityText: "skladom",
      price: "129.90",
      source: "text" as const,
      ok: true,
      error: null,
      httpStatus: 200,
      checkedAt: "2026-08-03T04:20:00.000Z",
      confirmedAt: "2026-08-03T04:20:00.000Z",
    },
  ],
  unreadable: [{ host: "dogtrace.com", count: 2, samples: ["https://dogtrace.com/obojok"] }],
  lastRun: {
    startedAt: "2026-08-03T04:20:00.000Z",
    finishedAt: "2026-08-03T04:41:00.000Z",
    status: "success" as const,
    errorMessage: null,
    result: {
      total: 238,
      skipped: 10,
      checked: 228,
      available: 120,
      unavailable: 90,
      unknown: 20,
      failed: 8,
      hosts: ["huntingshop.eu"],
    },
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("zobrazí prehľad dostupnosti u dodávateľov", async () => {
  fetchSupplierStockStatus.mockResolvedValue(STATUS);
  render(<SupplierStockSection role="admin" onSessionExpired={vi.fn()} />);

  expect((await screen.findByTestId("ss-total")).textContent).toContain("238");
  expect(screen.getByTestId("ss-available").textContent).toContain("120");
  expect(screen.getByTestId("ss-unknown").textContent).toContain("20");
  expect(screen.getByTestId("ss-failed").textContent).toContain("8");
});

// Karta nečitateľných stránok je VÝSLOVNÁ požiadavka majiteľa namiesto AI
// (3. 8. 2026) — bez nej sa nedá rozhodnúť, pre ktorého dodávateľa sa oplatí
// dorobiť čítanie ručne.
it("ukáže domény, ktoré sa nedarí prečítať, aj s ukážkovým odkazom", async () => {
  fetchSupplierStockStatus.mockResolvedValue(STATUS);
  render(<SupplierStockSection role="admin" onSessionExpired={vi.fn()} />);

  const karta = await screen.findByTestId("ss-unreadable");
  expect(karta.textContent).toContain("dogtrace.com");
  expect(karta.textContent).toContain("2");
  expect(screen.getByRole("link", { name: "https://dogtrace.com/obojok" })).toBeTruthy();
});

it("bez nečitateľných stránok povie, že je všetko v poriadku", async () => {
  fetchSupplierStockStatus.mockResolvedValue({ ...STATUS, unreadable: [] });
  render(<SupplierStockSection role="admin" onSessionExpired={vi.fn()} />);

  expect((await screen.findByTestId("ss-unreadable")).textContent).toContain("Zatiaľ žiadne");
});

it("„Spustiť teraz\" spustí kontrolu a znovu načíta prehľad", async () => {
  fetchSupplierStockStatus.mockResolvedValue(STATUS);
  runSupplierStockNow.mockResolvedValue(STATUS.lastRun.result);
  render(<SupplierStockSection role="admin" onSessionExpired={vi.fn()} />);

  fireEvent.click(await screen.findByTestId("ss-run-now"));

  await waitFor(() => {
    expect(runSupplierStockNow).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => {
    expect(fetchSupplierStockStatus).toHaveBeenCalledTimes(2);
  });
  expect((await screen.findByRole("status")).textContent).toContain("Skontrolovaných 228");
});

// Rola „čítanie" smie prehľad VIDIEŤ, ale nesmie spúšťať kontrolu —
// server to vynucuje `requireRole("admin", "manazer")`, UI to len zrkadlí.
it("role „čítanie\" tlačidlo na spustenie neponúkne, prehľad áno", async () => {
  fetchSupplierStockStatus.mockResolvedValue(STATUS);
  render(<SupplierStockSection role="citanie" onSessionExpired={vi.fn()} />);

  expect((await screen.findByTestId("ss-total")).textContent).toContain("238");
  expect(screen.queryByTestId("ss-run-now")).toBeNull();
});

it("vypršaná relácia odhlási, nezobrazí chybu", async () => {
  const onSessionExpired = vi.fn();
  fetchSupplierStockStatus.mockRejectedValue(new SupplierStockUnauthorizedError());
  render(<SupplierStockSection role="admin" onSessionExpired={onSessionExpired} />);

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});
