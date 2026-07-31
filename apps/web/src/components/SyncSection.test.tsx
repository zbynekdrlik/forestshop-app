import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SyncSection } from "./SyncSection.js";

const { fetchJobRuns, triggerCatalogIngest, triggerOrdersIngest } = vi.hoisted(() => ({
  fetchJobRuns: vi.fn(),
  triggerCatalogIngest: vi.fn(),
  triggerOrdersIngest: vi.fn(),
}));

// Skutočné triedy (`SchedulerUnauthorizedError`/`CatalogUnauthorizedError`/
// `OrdersUnauthorizedError`) ostávajú z reálnych modulov (spread cez
// `importOriginal`) — `instanceof` v komponente musí fungovať rovnako ako
// v teste, rovnaký vzor ako `CatalogPage.test.tsx`/`SchedulerSection.test.tsx`.
vi.mock("../schedulerApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../schedulerApi.js")>();
  return { ...actual, fetchJobRuns };
});
vi.mock("../catalogApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../catalogApi.js")>();
  return { ...actual, triggerCatalogIngest };
});
vi.mock("../ordersApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ordersApi.js")>();
  return { ...actual, triggerOrdersIngest };
});

const { SchedulerUnauthorizedError } = await import("../schedulerApi.js");

const CATALOG_RUN = {
  jobName: "catalog-import",
  startedAt: "2026-07-30T01:00:00.000Z",
  finishedAt: "2026-07-30T01:00:05.000Z",
  status: "success" as const,
  detail: { variantCount: 35 },
  errorMessage: null,
};

const ORDERS_RUN = {
  jobName: "orders-import",
  startedAt: "2026-07-30T01:45:00.000Z",
  finishedAt: "2026-07-30T01:45:03.000Z",
  status: "failure" as const,
  detail: null,
  errorMessage: "Import objednávok nie je nakonfigurovaný (chýba SHOPTET_ORDERS_URL)",
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("pre rolu bez oprávnenia (citanie/sef) zobrazí hlášku o nedostupnosti a nič nenačíta", () => {
  render(<SyncSection role="citanie" onSessionExpired={() => {}} />);
  expect(screen.getByText("Táto obrazovka je dostupná len pre rolu admin alebo manažér.")).toBeTruthy();
  expect(fetchJobRuns).not.toHaveBeenCalled();
});

it("keď zatiaľ žiadny beh nie je zaznamenaný, oba kanály aj história ukazujú 'zatiaľ nikdy'", async () => {
  fetchJobRuns.mockResolvedValue([]);

  render(<SyncSection role="manazer" onSessionExpired={() => {}} />);

  const katalog = await screen.findByTestId("sync-channel-Katalóg");
  expect(katalog.textContent).toContain("zatiaľ nikdy");
  const objednavky = screen.getByTestId("sync-channel-Objednávky");
  expect(objednavky.textContent).toContain("zatiaľ nikdy");
  expect(screen.getByTestId("sync-history-empty")).toBeTruthy();
});

it("zobrazí posledný beh katalógu (OK) aj objednávok (CHYBA) so slovenským detailom v histórii", async () => {
  fetchJobRuns.mockResolvedValue([CATALOG_RUN, ORDERS_RUN]);

  render(<SyncSection role="admin" onSessionExpired={() => {}} />);

  const katalog = await screen.findByTestId("sync-channel-Katalóg");
  expect(katalog.textContent).toContain("✅ OK");
  const objednavky = screen.getByTestId("sync-channel-Objednávky");
  expect(objednavky.textContent).toContain("❌ CHYBA");
  expect(objednavky.textContent).toContain("SHOPTET_ORDERS_URL");

  expect(screen.getByTestId("sync-job-catalog-import").textContent).toContain("Import katalógu");
  expect(screen.getByTestId("sync-job-orders-import").textContent).toContain("Import objednávok");
});

// #115 (majiteľ: "nemoze tam bezat ok ked posledny sync bol dni dozadu!!!") —
// posledný ÚSPEŠNÝ beh spred 3 dní nesmie ukázať zelené "✅ OK". Dátum je
// relatívny k reálnemu "teraz" (nie natvrdo zapísaný literál) — inak by sa
// táto asercia sama stala časovanou bombou presne z toho istého dôvodu, pre
// ktorý táto oprava vôbec vznikla.
it("posledný úspešný beh spred 3 dní ukáže zastaraný/varovný stav, NIE '✅ OK'", async () => {
  const predTromiDnami = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  fetchJobRuns.mockResolvedValue([
    { ...CATALOG_RUN, startedAt: predTromiDnami, finishedAt: predTromiDnami },
  ]);

  render(<SyncSection role="admin" onSessionExpired={() => {}} />);

  const katalog = await screen.findByTestId("sync-channel-Katalóg");
  expect(katalog.textContent).not.toContain("✅ OK");
  expect(katalog.textContent).toContain("Posledný úspešný sync");
  expect(katalog.textContent).toContain("dňami");
});

it("klik na 'Stiahnuť teraz' pre katalóg spustí triggerCatalogIngest a zobrazí výsledok", async () => {
  fetchJobRuns.mockResolvedValue([]);
  triggerCatalogIngest.mockResolvedValue({ status: "accepted", snapshotId: "s1", variantCount: 35, productCount: 8, missingCount: 0, issueCount: 0 });

  render(<SyncSection role="admin" onSessionExpired={() => {}} />);

  const katalog = await screen.findByTestId("sync-channel-Katalóg");
  fireEvent.click(within(katalog).getByRole("button", { name: "⚡ Stiahnuť teraz" }));

  await waitFor(() => {
    expect(katalog.textContent).toContain("Import bol úspešný");
  });
  expect(fetchJobRuns).toHaveBeenCalledTimes(2); // pri mounte + po dobehnutom importe
});

it("klik na 'Stiahnuť teraz' pre objednávky spustí triggerOrdersIngest a zobrazí výsledok", async () => {
  fetchJobRuns.mockResolvedValue([]);
  triggerOrdersIngest.mockResolvedValue({ status: "rejected", reason: "prázdny export" });

  render(<SyncSection role="admin" onSessionExpired={() => {}} />);

  const objednavky = await screen.findByTestId("sync-channel-Objednávky");
  fireEvent.click(within(objednavky).getByRole("button", { name: "⚡ Stiahnuť teraz" }));

  await waitFor(() => {
    expect(objednavky.textContent).toContain("Import bol zamietnutý");
    expect(objednavky.textContent).toContain("prázdny export");
  });
});

it("pri 401 zavolá onSessionExpired namiesto zobrazenia všeobecnej chyby", async () => {
  fetchJobRuns.mockRejectedValue(new SchedulerUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<SyncSection role="manazer" onSessionExpired={onSessionExpired} />);

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keď prehľad zlyhá inou chybou, zobrazí vlastnú slovenskú hlášku", async () => {
  fetchJobRuns.mockRejectedValue(new Error("network"));

  render(<SyncSection role="manazer" onSessionExpired={() => {}} />);

  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe("Prehľad synchronizácie sa nepodarilo načítať.");
  });
});
