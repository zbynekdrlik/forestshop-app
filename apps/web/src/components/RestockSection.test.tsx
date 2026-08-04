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
      ourUrl: "https://www.forestshop.sk/ladvinka-swedteam-green/?variantId=4211",
    },
    {
      // Kód, ktorý vo feede pre porovnávače NIE JE (issue 220) — dnes je
      // takých 626 viditeľných variantov. Riadok musí zostať v zozname a
      // odkaz padnúť späť na vyhľadávanie, nikdy nie na prázdny odkaz.
      variantCode: "15314",
      pairCode: null,
      productName: "Poľovnícky ruksak HART SPEAN 25",
      supplier: "BETALOV",
      supplierLink: "https://huntingshop.example/spean",
      supplierAvailabilityText: "skladom",
      supplierPrice: "59.00",
      confirmedAt: "2026-08-04T04:21:00.000Z",
      ourUrl: null,
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
  // issue 226: prázdny predvolený stav — testy, ktoré rozpor priamo
  // nepotrebujú, ho takto nemusia riešiť.
  feedConflicts: { total: 0, rows: [] },
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
  // Priama adresa z feedu vrátane výberu veľkosti — nie vyhľadávanie.
  expect(odkazy).toEqual([
    "https://www.forestshop.sk/ladvinka-swedteam-green/?variantId=4211",
    "https://tthunt.example/ladvinka",
  ]);

  // Variant, ktorý vo feede nie je, ostáva v zozname a má náhradný odkaz.
  const bezFeedu = await screen.findByTestId("restock-waiting-15314");
  expect([...bezFeedu.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
    "https://www.forestshop.sk/vyhladavanie/?string=15314",
    "https://huntingshop.example/spean",
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

// issue 226: krížová kontrola proti Shoptetovmu feedu — rozpor sa MUSÍ ukázať
// na obrazovke ako varovanie s číslom a zoznamom, nikdy len v logu.
it("ukáže varovanie o rozpore nášho stavu s feedom, s počtom aj zoznamom", async () => {
  fetchRestockStatus.mockResolvedValue({
    ...STATUS,
    feedConflicts: {
      total: 2,
      rows: [
        {
          variantCode: "B1",
          productName: "Bunda Forest",
          ourState: "out_of_stock" as const,
          feedAvailability: "in stock",
          ourUrl: "https://www.forestshop.sk/bunda-forest/",
        },
        {
          // issue 226 review: `ourUrl` je v `feedConflictRowSchema` VŽDY
          // nenulový reťazec — rozpor existuje len pre variant, ktorý MÁ
          // riadok vo feede (INNER JOIN, `feed-cross-check.ts`), takže mock
          // musí niesť skutočnú adresu, nikdy `null` (na rozdiel od
          // `RestockWaitingRow.ourUrl`, ktoré nullable JE).
          variantCode: "C1",
          productName: "Nohavice X",
          ourState: "sellable" as const,
          feedAvailability: "out of stock",
          ourUrl: "https://www.forestshop.sk/nohavice-x/",
        },
      ],
    },
  });
  render(<RestockSection role="admin" onSessionExpired={vi.fn()} />);

  const karta = await screen.findByTestId("restock-feed-conflicts");
  expect(karta.textContent).toContain("2");
  expect(karta.textContent).toContain("Bunda Forest");
  expect(karta.textContent).toContain("Nohavice X");
});

it("bez rozporov ukáže, že sa všetko zhoduje", async () => {
  fetchRestockStatus.mockResolvedValue(STATUS);
  render(<RestockSection role="admin" onSessionExpired={vi.fn()} />);

  const karta = await screen.findByTestId("restock-feed-conflicts");
  expect(karta.textContent).toMatch(/žiadne|zhod/i);
});

it("role „čítanie\" ovládacie tlačidlá neponúkne", async () => {
  fetchRestockStatus.mockResolvedValue(STATUS);
  render(<RestockSection role="citanie" onSessionExpired={vi.fn()} />);

  expect(await screen.findByTestId("restock-status-pill")).toBeTruthy();
  expect(screen.queryByTestId("restock-toggle")).toBeNull();
  expect(screen.queryByTestId("restock-run-now")).toBeNull();
});
