import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SchedulerSection } from "./SchedulerSection.js";

const { fetchJobRuns } = vi.hoisted(() => ({ fetchJobRuns: vi.fn() }));

// `SchedulerUnauthorizedError` ostáva SKUTOČNÁ trieda z reálneho modulu (rovnaký
// dôvod ako `CatalogPage.test.tsx`'s `CatalogUnauthorizedError` — `instanceof`
// v komponente musí fungovať aj v teste).
vi.mock("../schedulerApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../schedulerApi.js")>();
  return { ...actual, fetchJobRuns };
});

const { SchedulerUnauthorizedError } = await import("../schedulerApi.js");

const RUN_SUCCESS = {
  jobName: "prune-raw-exports",
  startedAt: "2026-07-29T01:15:00.000Z",
  finishedAt: "2026-07-29T01:15:02.000Z",
  status: "success" as const,
  detail: { removed: 3 },
  errorMessage: null,
};

const RUN_FAILURE = {
  jobName: "catalog-import",
  startedAt: "2026-07-29T01:00:00.000Z",
  finishedAt: "2026-07-29T01:00:01.000Z",
  status: "failure" as const,
  detail: null,
  errorMessage: "Import katalógu nie je nakonfigurovaný (chýba SHOPTET_EXPORT_URL)",
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("pre rolu bez oprávnenia (citanie/sef) sa vôbec nevykreslí a nič nenačíta", () => {
  const { container } = render(<SchedulerSection role="citanie" onSessionExpired={() => {}} />);
  expect(container.firstChild).toBeNull();
  expect(fetchJobRuns).not.toHaveBeenCalled();
});

it("keď zatiaľ žiadny beh nie je zaznamenaný, zobrazí informačnú vetu namiesto holej tabuľky", async () => {
  fetchJobRuns.mockResolvedValue([]);

  render(<SchedulerSection role="manazer" onSessionExpired={() => {}} />);

  await screen.findByTestId("scheduler-empty");
  expect(screen.queryByRole("table")).toBeNull();
});

it("zobrazí posledný beh každej úlohy so slovenským menom, stavom a detailom", async () => {
  fetchJobRuns.mockResolvedValue([RUN_SUCCESS, RUN_FAILURE]);

  render(<SchedulerSection role="admin" onSessionExpired={() => {}} />);

  const uspesny = await screen.findByTestId("job-prune-raw-exports");
  expect(uspesny.textContent).toContain("Mazanie starých surových exportov");
  expect(uspesny.textContent).toContain("Úspešná");
  expect(uspesny.textContent).toContain("removed");

  const zlyhany = screen.getByTestId("job-catalog-import");
  expect(zlyhany.textContent).toContain("Import katalógu");
  expect(zlyhany.textContent).toContain("Zlyhala");
  expect(zlyhany.textContent).toContain("SHOPTET_EXPORT_URL");
});

it("bežiaci beh (finishedAt: null) zobrazí pomlčku namiesto neplatného dátumu", async () => {
  fetchJobRuns.mockResolvedValue([{ ...RUN_SUCCESS, status: "running" as const, finishedAt: null }]);

  render(<SchedulerSection role="manazer" onSessionExpired={() => {}} />);

  const riadok = await screen.findByTestId("job-prune-raw-exports");
  expect(riadok.textContent).toContain("Beží");
  expect(riadok.textContent).toContain("—");
});

it("pri 401 zavolá onSessionExpired namiesto zobrazenia všeobecnej chyby", async () => {
  fetchJobRuns.mockRejectedValue(new SchedulerUnauthorizedError());
  const onSessionExpired = vi.fn();

  render(<SchedulerSection role="manazer" onSessionExpired={onSessionExpired} />);

  await waitFor(() => {
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keď prehľad zlyhá inou chybou, zobrazí vlastnú slovenskú hlášku", async () => {
  fetchJobRuns.mockRejectedValue(new Error("network"));

  render(<SchedulerSection role="manazer" onSessionExpired={() => {}} />);

  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toBe("Prehľad plánovača sa nepodarilo načítať.");
  });
});
