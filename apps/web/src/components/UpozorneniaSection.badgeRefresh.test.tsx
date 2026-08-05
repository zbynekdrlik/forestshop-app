import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UpozorneniaBadgeRefreshContext } from "../upozorneniaBadgeContext.js";
import { UpozorneniaSection } from "./UpozorneniaSection.js";

// issue 267 (živé overenie, gap 1): odznak v ľavom menu klamal, kým sa
// stránka neobnovila — mutácia (vytvorenie/odloženie/vybavenie) na PRÁVE
// otvorenej obrazovke nemala žiadny spúšťač refetchu. Tento test overuje, že
// `UpozorneniaSection` po KAŽDEJ úspešnej mutácii zavolá `refresh()` z
// `UpozorneniaBadgeRefreshContext` — spotrebiteľ v produkčnom kóde
// (`App.tsx`) ho nahrádza spy funkciou, rovnaký vzor ako
// `OrdersSection.remainingCount.test.tsx`.

const { fetchUpozornenia, markUpozorneniaSeen, createOwnNote, resolveUpozornenie } = vi.hoisted(() => ({
  fetchUpozornenia: vi.fn(),
  markUpozorneniaSeen: vi.fn(),
  createOwnNote: vi.fn(),
  resolveUpozornenie: vi.fn(),
}));

vi.mock("../upozorneniaApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../upozorneniaApi.js")>();
  return { ...actual, fetchUpozornenia, markUpozorneniaSeen, createOwnNote, resolveUpozornenie };
});

const KARTA = {
  id: "own-1",
  type: "vlastna_poznamka" as const,
  source: "vlastne" as const,
  title: "Schôdzka v stredu",
  details: "",
  link: null,
  dueAt: null,
  postponedUntil: null,
  seenAt: null,
  resolvedAt: null,
  createdAt: "2026-08-05T08:00:00.000Z",
  status: "nove" as const,
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("klik na 'Vybavené' zavolá refresh() z UpozorneniaBadgeRefreshContext (odznak sa refetchne bez zmeny záložky)", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValueOnce([KARTA]).mockResolvedValueOnce([{ ...KARTA, status: "vybavene" as const }]);
  resolveUpozornenie.mockResolvedValue(undefined);
  const refresh = vi.fn();

  render(
    <UpozorneniaBadgeRefreshContext.Provider value={{ refresh }}>
      <UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />
    </UpozorneniaBadgeRefreshContext.Provider>,
  );
  await screen.findByTestId("upozornenie-own-1");
  expect(refresh).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId("upozornenie-resolve-own-1"));
  await waitFor(() => {
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

it("uloženie novej vlastnej poznámky ('+ Nové upozornenie') tiež zavolá refresh()", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValueOnce([]).mockResolvedValueOnce([KARTA]);
  createOwnNote.mockResolvedValue(undefined);
  const refresh = vi.fn();

  render(
    <UpozorneniaBadgeRefreshContext.Provider value={{ refresh }}>
      <UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />
    </UpozorneniaBadgeRefreshContext.Provider>,
  );
  await screen.findByTestId("upozornenia-empty");

  fireEvent.click(screen.getByTestId("upozornenie-new"));
  fireEvent.change(screen.getByTestId("upozornenie-form-title"), { target: { value: "Schôdzka v stredu" } });
  fireEvent.click(screen.getByTestId("upozornenie-form-save"));

  await waitFor(() => {
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
