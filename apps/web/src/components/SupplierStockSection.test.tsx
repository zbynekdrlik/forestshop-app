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

const LASTING_LINK = "https://shop.lasting.eu/cepice/bony";

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
      sizeLabel: "",
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
    {
      link: LASTING_LINK,
      sizeLabel: "L-X",
      host: "shop.lasting.eu",
      availability: "unavailable" as const,
      availabilityText: "L/XL",
      price: "15.90",
      source: "size_list" as const,
      ok: true,
      error: null,
      httpStatus: 200,
      checkedAt: "2026-08-03T04:20:00.000Z",
      confirmedAt: "2026-08-03T04:20:00.000Z",
    },
  ],
  unreadable: [
    { host: "dogtrace.com", count: 2, samples: [{ link: "https://dogtrace.com/obojok", sizeLabel: "" }] },
  ],
  hostOverview: [
    { host: "huntingshop.eu", total: 200, readable: 195, unknown: 3, failed: 2, lastConfirmedAt: "2026-08-03T04:20:00.000Z" },
    { host: "shop.lasting.eu", total: 38, readable: 20, unknown: 18, failed: 0, lastConfirmedAt: "2026-08-03T04:20:00.000Z" },
  ],
  ownShopLinksCount: 21,
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

// issue 227: prehľad podľa domény — koľko odkazov, koľko sa číta, aby bolo
// vidno, ktorú doménu je najviac hodno doplniť ako ďalšiu.
it("ukáže prehľad podľa domény zoradený podľa počtu odkazov klesajúco", async () => {
  fetchSupplierStockStatus.mockResolvedValue(STATUS);
  render(<SupplierStockSection role="admin" onSessionExpired={vi.fn()} />);

  const karta = await screen.findByTestId("ss-host-overview");
  expect(karta.textContent).toContain("huntingshop.eu");
  expect(karta.textContent).toContain("shop.lasting.eu");
  const domeny = karta.querySelectorAll("tbody tr");
  expect(domeny[0]?.textContent).toContain("huntingshop.eu");
  expect(domeny[1]?.textContent).toContain("shop.lasting.eu");
  expect(screen.getByTestId("ss-host-huntingshop.eu").textContent).toContain("200");
  expect(screen.getByTestId("ss-host-huntingshop.eu").textContent).toContain("195");
});

// Vylúčenie vlastného e-shopu (issue 227) nesmie byť tiché — majiteľ vidí,
// koľko odkazov sa NEscrapuje a prečo.
it("ukáže počet odkazov na vlastný e-shop, vylúčených z kontroly", async () => {
  fetchSupplierStockStatus.mockResolvedValue(STATUS);
  render(<SupplierStockSection role="admin" onSessionExpired={vi.fn()} />);

  const notice = await screen.findByTestId("ss-own-shop-links");
  expect(notice.textContent).toContain("21");
});

it("bez odkazov na vlastný e-shop sa upozornenie nezobrazí", async () => {
  fetchSupplierStockStatus.mockResolvedValue({ ...STATUS, ownShopLinksCount: 0 });
  render(<SupplierStockSection role="admin" onSessionExpired={vi.fn()} />);

  await screen.findByTestId("ss-total");
  expect(screen.queryByTestId("ss-own-shop-links")).toBeNull();
});

it("„Spustiť teraz\" spustí kontrolu a znovu načíta prehľad", async () => {
  // issue 413: run-now je ASYNC — `runSupplierStockNow()` už neresolvuje
  // výsledok priamo (server 202-ne hneď), komponent ho PREBERIE opakovaným
  // čítaním stavu (`pollUntilJobDone`, tu ihneď "success" — `STATUS` slúži
  // zároveň ako počiatočný AJ polovaný stav).
  fetchSupplierStockStatus.mockResolvedValue(STATUS);
  runSupplierStockNow.mockResolvedValue(undefined);
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

// issue 224: jedna linka môže mať teraz VIAC riadkov (jeden na každú našu
// veľkosť) — kľúč aj testid musia niesť aj veľkosť, inak by React zlúčil
// dva rôzne riadky do jedného.
it("odkaz s viacerými veľkosťami ukáže KAŽDÚ veľkosť ako vlastný riadok", async () => {
  const spolocnyRiadok = {
    link: LASTING_LINK,
    host: "shop.lasting.eu",
    availabilityText: "",
    price: "15.90",
    source: "size_list" as const,
    ok: true,
    error: null,
    httpStatus: 200,
    checkedAt: "2026-08-03T04:20:00.000Z",
    confirmedAt: "2026-08-03T04:20:00.000Z",
  };
  const dveVelkosti = {
    ...STATUS,
    rows: [
      { ...spolocnyRiadok, sizeLabel: "L-X", availability: "unavailable" as const },
      { ...spolocnyRiadok, sizeLabel: "S-M", availability: "available" as const },
    ],
  };
  fetchSupplierStockStatus.mockResolvedValue(dveVelkosti);
  render(<SupplierStockSection role="admin" onSessionExpired={vi.fn()} />);

  const lX = await screen.findByTestId(`ss-row-${LASTING_LINK}-L-X`);
  const sM = await screen.findByTestId(`ss-row-${LASTING_LINK}-S-M`);
  expect(lX.textContent).toContain("L-X");
  expect(lX.textContent).toContain("Vypredané");
  expect(sM.textContent).toContain("S-M");
  expect(sM.textContent).toContain("Skladom");
});
