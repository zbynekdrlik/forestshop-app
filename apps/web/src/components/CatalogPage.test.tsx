import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CatalogPage } from "./CatalogPage.js";

const { fetchCatalogStats, searchCatalogVariants, triggerCatalogIngest } = vi.hoisted(() => ({
  fetchCatalogStats: vi.fn(),
  searchCatalogVariants: vi.fn(),
  triggerCatalogIngest: vi.fn(),
}));

// `CatalogUnauthorizedError` ostáva SKUTOČNÁ trieda z reálneho modulu (spread cez
// `importOriginal`) — testy na 401 potrebujú `instanceof` fungujúci rovnako ako
// v komponente, nie duck-typed atrapu.
vi.mock("../catalogApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../catalogApi.js")>();
  return { ...actual, fetchCatalogStats, searchCatalogVariants, triggerCatalogIngest };
});

const { CatalogUnauthorizedError } = await import("../catalogApi.js");

const VARIANT_A = {
  code: "40237/3XL",
  productKey: "40237",
  sizeLabel: "3XL",
  name: "Nohavice FOREST 1003",
  state: "discontinued" as const,
  stock: 0,
  price: "62.76",
  currency: "EUR",
  availabilityText: "Skladom u dodávateľa",
  missingSince: null,
};

const ACCEPTED_STATS = {
  variantCount: 35,
  productCount: 8,
  sellable: 6,
  outOfStock: 4,
  discontinued: 25,
  missing: 0,
  lastSnapshot: {
    id: "s1",
    fetchedAt: "2026-07-29T10:00:00.000Z",
    sourceLabel: "fixtúra",
    verdict: "accepted" as const,
    rejectionReason: null,
    rowCount: 35,
    byteSize: 92_000,
    columnCount: 265,
    variantCount: 35,
    productCount: 8,
    issueCount: 2,
  },
};

const NO_SNAPSHOT_STATS = { ...ACCEPTED_STATS, lastSnapshot: null };

const REJECTED_STATS = {
  ...ACCEPTED_STATS,
  lastSnapshot: {
    ...ACCEPTED_STATS.lastSnapshot,
    verdict: "rejected" as const,
    rejectionReason: "Export má len 900 riadkov, minimum pre prvý import je 1000.",
    variantCount: null,
    productCount: null,
    issueCount: null,
  },
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("keď katalóg ešte nikdy nebol importovaný, zobrazí informačnú vetu", async () => {
  fetchCatalogStats.mockResolvedValue(NO_SNAPSHOT_STATS);
  searchCatalogVariants.mockResolvedValue({ total: 0, items: [] });

  render(<CatalogPage role="manazer" onSessionExpired={() => {}} />);

  await waitFor(() => {
    expect(screen.getByTestId("snapshot").textContent).toBe("Katalóg zatiaľ nebol importovaný.");
  });
  expect(screen.queryByTestId("rejection-alert")).toBeNull();
});

it("keď posledný import bol zamietnutý, zobrazí samostatný alert s dôvodom a poznámkou, že čísla sú staršie", async () => {
  fetchCatalogStats.mockResolvedValue(REJECTED_STATS);
  searchCatalogVariants.mockResolvedValue({ total: 0, items: [] });

  render(<CatalogPage role="manazer" onSessionExpired={() => {}} />);

  const alert = await screen.findByTestId("rejection-alert");
  expect(alert.getAttribute("role")).toBe("alert");
  expect(alert.textContent).toContain("zamietnutý");
  expect(alert.textContent).toContain("Export má len 900 riadkov, minimum pre prvý import je 1000.");
  expect(alert.textContent).toContain("predchádzajúceho");
  expect(alert.textContent).toContain("fixtúra");
  // Chýbajúci `issueCount` (rejected snapshot ho zo servera nedostáva) sa zobrazí
  // ako pomlčka, nie ako "null" alebo ticho vynechaný.
  expect(alert.textContent).toContain("anomálií: —");
});

it("keď prehľad zlyhá, zobrazí vlastnú chybu a prestane ukazovať 'Načítavam…'; nová chyba vyhľadávania ju nezmaže", async () => {
  fetchCatalogStats.mockRejectedValue(new Error("network"));
  searchCatalogVariants.mockResolvedValueOnce({ total: 0, items: [] });
  searchCatalogVariants.mockRejectedValueOnce(new Error("network"));

  render(<CatalogPage role="manazer" onSessionExpired={() => {}} />);

  await waitFor(() => {
    expect(screen.getByText("Prehľad katalógu sa nepodarilo načítať.")).not.toBeNull();
  });
  expect(screen.queryByText("Načítavam prehľad…")).toBeNull();

  fireEvent.change(screen.getByLabelText("Kód alebo názov"), { target: { value: "x" } });
  fireEvent.click(screen.getByRole("button", { name: "Hľadať" }));

  await waitFor(() => {
    expect(screen.getByText("Vyhľadávanie zlyhalo — server neodpovedal.")).not.toBeNull();
  });
  // Predchádzajúca chyba prehľadu musí zostať — tri operácie majú oddelený stav.
  expect(screen.getByText("Prehľad katalógu sa nepodarilo načítať.")).not.toBeNull();
});

it("keď hľadanie nenájde nič, zobrazí slovenskú vetu namiesto holej tabuľky", async () => {
  fetchCatalogStats.mockResolvedValue(ACCEPTED_STATS);
  searchCatalogVariants.mockResolvedValue({ total: 0, items: [] });

  render(<CatalogPage role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId("empty-results");
  expect(screen.queryByRole("table")).toBeNull();
});

it("staršia, ale pomalšia odpoveď hľadania neprepíše novší, rýchlejší výsledok", async () => {
  fetchCatalogStats.mockResolvedValue(ACCEPTED_STATS);

  let resolveStaleBroad: (value: unknown) => void = () => {
    throw new Error("resolveStaleBroad nebol nastavený");
  };
  // Prvé volanie (automatický mount efekt, prázdny dopyt) — zostane visieť,
  // simuluje pomalší neindexovaný sken nad celým katalógom.
  searchCatalogVariants.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveStaleBroad = resolve;
      }),
  );
  // Druhé volanie (užší dopyt zadaný používateľom) sa vráti okamžite.
  searchCatalogVariants.mockResolvedValueOnce({ total: 1, items: [VARIANT_A] });

  render(<CatalogPage role="manazer" onSessionExpired={() => {}} />);

  await waitFor(() => {
    expect(searchCatalogVariants).toHaveBeenCalledTimes(1);
  });

  fireEvent.change(screen.getByLabelText("Kód alebo názov"), { target: { value: "40237/3XL" } });
  fireEvent.click(screen.getByRole("button", { name: "Hľadať" }));

  await waitFor(() => {
    expect(screen.getByTestId("total").textContent).toBe("Nájdených: 1");
  });

  // Teraz príde neskorá odpoveď na PÔVODNÝ, širší dopyt — nesmie prepísať už
  // zobrazený novší, užší výsledok.
  resolveStaleBroad({ total: 35, items: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(screen.getByTestId("total").textContent).toBe("Nájdených: 1");
  expect(screen.getByTestId("variant-40237/3XL")).not.toBeNull();
});

it("import 'accepted' zobrazí úspešnú hlášku s počtami", async () => {
  fetchCatalogStats.mockResolvedValue(ACCEPTED_STATS);
  searchCatalogVariants.mockResolvedValue({ total: 0, items: [] });
  triggerCatalogIngest.mockResolvedValue({
    status: "accepted",
    snapshotId: "s2",
    variantCount: 40,
    productCount: 9,
    missingCount: 1,
    issueCount: 3,
  });

  render(<CatalogPage role="manazer" onSessionExpired={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Stiahnuť a naimportovať export" }));

  const outcome = await screen.findByTestId("import-outcome");
  expect(outcome.getAttribute("role")).toBe("status");
  expect(outcome.textContent).toContain("úspešný");
  expect(outcome.textContent).toContain("40");
});

it("import 'rejected' zobrazí zamietnutie s dôvodom ako alert", async () => {
  fetchCatalogStats.mockResolvedValue(ACCEPTED_STATS);
  searchCatalogVariants.mockResolvedValue({ total: 0, items: [] });
  triggerCatalogIngest.mockResolvedValue({
    status: "rejected",
    snapshotId: "s3",
    reason: "export je príliš malý",
  });

  render(<CatalogPage role="manazer" onSessionExpired={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Stiahnuť a naimportovať export" }));

  const outcome = await screen.findByTestId("import-outcome");
  expect(outcome.getAttribute("role")).toBe("alert");
  expect(outcome.textContent).toContain("zamietnutý");
  expect(outcome.textContent).toContain("export je príliš malý");
});

it("import 'duplicate' oznámi, že sa nič nezmenilo", async () => {
  fetchCatalogStats.mockResolvedValue(ACCEPTED_STATS);
  searchCatalogVariants.mockResolvedValue({ total: 0, items: [] });
  triggerCatalogIngest.mockResolvedValue({ status: "duplicate", snapshotId: "s4" });

  render(<CatalogPage role="manazer" onSessionExpired={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Stiahnuť a naimportovať export" }));

  const outcome = await screen.findByTestId("import-outcome");
  expect(outcome.getAttribute("role")).toBe("status");
  expect(outcome.textContent).toContain("nezmenil");
});

it("import 'busy' oznámi, že import už beží", async () => {
  fetchCatalogStats.mockResolvedValue(ACCEPTED_STATS);
  searchCatalogVariants.mockResolvedValue({ total: 0, items: [] });
  triggerCatalogIngest.mockResolvedValue({ status: "busy" });

  render(<CatalogPage role="manazer" onSessionExpired={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Stiahnuť a naimportovať export" }));

  const outcome = await screen.findByTestId("import-outcome");
  expect(outcome.getAttribute("role")).toBe("alert");
  expect(outcome.textContent).toContain("už prebieha");
});

it("tlačidlo importu sa nezobrazí pre rolu bez oprávnenia na server-side ingest", async () => {
  fetchCatalogStats.mockResolvedValue(ACCEPTED_STATS);
  searchCatalogVariants.mockResolvedValue({ total: 0, items: [] });

  render(<CatalogPage role="citanie" onSessionExpired={() => {}} />);

  await screen.findByTestId("snapshot");
  expect(screen.queryByRole("button", { name: "Stiahnuť a naimportovať export" })).toBeNull();
});

it("tlačidlo importu sa zobrazí pre rolu manažér", async () => {
  fetchCatalogStats.mockResolvedValue(ACCEPTED_STATS);
  searchCatalogVariants.mockResolvedValue({ total: 0, items: [] });

  render(<CatalogPage role="manazer" onSessionExpired={() => {}} />);

  await screen.findByRole("button", { name: "Stiahnuť a naimportovať export" });
});

it("keď server vráti 401, zavolá onSessionExpired namiesto zobrazenia všeobecnej chyby", async () => {
  fetchCatalogStats.mockRejectedValue(new CatalogUnauthorizedError());
  searchCatalogVariants.mockResolvedValue({ total: 0, items: [] });
  const onSessionExpired = vi.fn();

  render(<CatalogPage role="manazer" onSessionExpired={onSessionExpired} />);

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
  expect(screen.queryByRole("alert")).toBeNull();
});
