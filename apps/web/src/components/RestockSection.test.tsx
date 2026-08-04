import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RestockSection } from "./RestockSection.js";

const { fetchRestockStatus, fetchRestockWaiting, runRestockNow, setRestockEnabled } = vi.hoisted(
  () => ({
    fetchRestockStatus: vi.fn(),
    fetchRestockWaiting: vi.fn(),
    runRestockNow: vi.fn(),
    setRestockEnabled: vi.fn(),
  }),
);

vi.mock("../restockApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../restockApi.js")>();
  return { ...actual, fetchRestockStatus, fetchRestockWaiting, runRestockNow, setRestockEnabled };
});

const WAITING = {
  total: 250,
  rows: [
    {
      variantCode: "60542",
      pairCode: null,
      productName: "Ľadvinka SWEDTEAM GREEN",
      supplier: "TTHUNT",
      supplierLink: "https://tthunt.example/ladvinka",
      supplierAvailabilityText: "skladom",
      supplierPrice: "24.00",
      confirmedAt: "2026-08-04T04:20:00.000Z",
    },
  ],
  suppliers: [
    { name: "BETALOV", count: 200 },
    { name: "TTHUNT", count: 50 },
  ],
};

const STATUS = {
  enabled: false,
  maxPerRun: 50,
  waiting: { now: 12, overLimit: 0 },
  events: [
    {
      id: "e1",
      at: "2026-08-04T04:50:00.000Z",
      variantCode: "40237/L",
      pairCode: "77",
      productName: "Nohavice FOREST",
      supplier: "Huntingshop",
      supplierLink: "https://huntingshop.eu/nohavice",
      supplierAvailabilityText: "skladom",
      supplierPrice: "59.90",
      confirmedAt: "2026-08-04T04:20:00.000Z",
    },
  ],
  lastRun: {
    startedAt: "2026-08-04T04:50:00.000Z",
    finishedAt: "2026-08-04T04:52:00.000Z",
    status: "success" as const,
    errorMessage: null,
    result: { status: "ok" as const, switched: 1, overLimit: 0, codes: ["40237/L"] },
    skippedReason: null,
  },
};

beforeEach(() => {
  fetchRestockWaiting.mockResolvedValue(WAITING);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Majiteľ: "bude to tam vydno ze to funguje a ze to prepina produkty" — tabuľka
// prepnutých produktov je celý zmysel tejto obrazovky.
it("ukáže, ktoré produkty automatizácia prepla", async () => {
  fetchRestockStatus.mockResolvedValue(STATUS);
  render(<RestockSection role="admin" onSessionExpired={vi.fn()} />);

  const riadok = await screen.findByTestId("restock-event-40237/L");
  expect(riadok.textContent).toContain("Nohavice FOREST");
  expect(riadok.textContent).toContain("Huntingshop");
  expect(screen.getByRole("link", { name: "skladom" }).getAttribute("href")).toBe(
    "https://huntingshop.eu/nohavice",
  );
});

it("ukáže, koľko produktov čaká na najbližší beh", async () => {
  fetchRestockStatus.mockResolvedValue(STATUS);
  render(<RestockSection role="admin" onSessionExpired={vi.fn()} />);

  expect((await screen.findByTestId("restock-waiting")).textContent).toContain("12");
});

it("pri prekročení stropu napíše, koľko ich čaká navyše", async () => {
  fetchRestockStatus.mockResolvedValue({ ...STATUS, waiting: { now: 50, overLimit: 130 } });
  render(<RestockSection role="admin" onSessionExpired={vi.fn()} />);

  expect((await screen.findByTestId("restock-waiting")).textContent).toContain("130");
});

it("Štart/Stop prepne automatizáciu a znovu načíta stav", async () => {
  fetchRestockStatus.mockResolvedValue(STATUS);
  setRestockEnabled.mockResolvedValue(true);
  render(<RestockSection role="admin" onSessionExpired={vi.fn()} />);

  fireEvent.click(await screen.findByTestId("restock-toggle"));

  await waitFor(() => {
    expect(setRestockEnabled).toHaveBeenCalledWith(true);
  });
  await waitFor(() => {
    expect(fetchRestockStatus).toHaveBeenCalledTimes(2);
  });
});

// Zlyhanie zápisu do Shoptetu sa NESMIE tváriť ako úspech — obsluha musí
// vidieť, že sa nič nepreplo.
it("po zlyhaní zápisu povie, že sa nič neprepínalo", async () => {
  fetchRestockStatus.mockResolvedValue(STATUS);
  runRestockNow.mockResolvedValue({
    status: "failed",
    attempted: 3,
    overLimit: 0,
    errorDetail: "prihlásenie zlyhalo",
  });
  render(<RestockSection role="admin" onSessionExpired={vi.fn()} />);

  fireEvent.click(await screen.findByTestId("restock-run-now"));

  expect((await screen.findByRole("status")).textContent).toContain("Nič sa nepreplo");
});

// issue 217 — majiteľ: "link na nas produkt a link na produkt dodavatela …
// potvaram si zo sto a overim". Oba odkazy vedľa seba sú celý zmysel karty.
it("pri každom čakajúcom produkte ponúkne odkaz na náš eshop aj k dodávateľovi", async () => {
  fetchRestockStatus.mockResolvedValue(STATUS);
  render(<RestockSection role="admin" onSessionExpired={vi.fn()} />);

  const riadok = await screen.findByTestId("restock-waiting-60542");
  const odkazy = [...riadok.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  expect(odkazy).toEqual([
    "https://www.forestshop.sk/vyhladavanie/?string=60542",
    "https://tthunt.example/ladvinka",
  ]);
  // Nová karta — inak by preklikávanie zoznam pod rukami zavrelo.
  expect([...riadok.querySelectorAll("a")].every((a) => a.getAttribute("target") === "_blank")).toBe(
    true,
  );
});

it("filter podľa dodávateľa načíta zoznam odznova od prvej stránky", async () => {
  fetchRestockStatus.mockResolvedValue(STATUS);
  render(<RestockSection role="admin" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("restock-waiting-60542");

  fireEvent.click(await screen.findByTestId("restock-waiting-next"));
  await waitFor(() => {
    expect(fetchRestockWaiting).toHaveBeenLastCalledWith({ limit: 100, offset: 100, supplier: "" });
  });

  fireEvent.change(screen.getByTestId("restock-waiting-supplier"), { target: { value: "TTHUNT" } });
  await waitFor(() => {
    expect(fetchRestockWaiting).toHaveBeenLastCalledWith({
      limit: 100,
      offset: 0,
      supplier: "TTHUNT",
    });
  });
});

it("ukáže, koľkátý úsek zo všetkých čakajúcich práve pozeráš", async () => {
  fetchRestockStatus.mockResolvedValue(STATUS);
  render(<RestockSection role="admin" onSessionExpired={vi.fn()} />);

  expect((await screen.findByTestId("restock-waiting-range")).textContent).toContain("z 250");
});

it("role „čítanie\" ovládacie tlačidlá neponúkne", async () => {
  fetchRestockStatus.mockResolvedValue(STATUS);
  render(<RestockSection role="citanie" onSessionExpired={vi.fn()} />);

  expect(await screen.findByTestId("restock-status-pill")).toBeTruthy();
  expect(screen.queryByTestId("restock-toggle")).toBeNull();
  expect(screen.queryByTestId("restock-run-now")).toBeNull();
});
