import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UpozorneniaSection } from "./UpozorneniaSection.js";

const { fetchUpozornenia, markUpozorneniaSeen, createOwnNote, updateOwnNote, deleteOwnNote, resolveUpozornenie, postponeUpozornenie } = vi.hoisted(() => ({
  fetchUpozornenia: vi.fn(),
  markUpozorneniaSeen: vi.fn(),
  createOwnNote: vi.fn(),
  updateOwnNote: vi.fn(),
  deleteOwnNote: vi.fn(),
  resolveUpozornenie: vi.fn(),
  postponeUpozornenie: vi.fn(),
}));

// `UpozorneniaUnauthorizedError` ostáva SKUTOČNÁ trieda (rovnaký dôvod ako
// `NedostupneSection.test.tsx` — `instanceof` v komponente musí fungovať).
vi.mock("../upozorneniaApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../upozorneniaApi.js")>();
  return { ...actual, fetchUpozornenia, markUpozorneniaSeen, createOwnNote, updateOwnNote, deleteOwnNote, resolveUpozornenie, postponeUpozornenie };
});

const VLASTNA_KARTA = {
  id: "own-1",
  type: "vlastna_poznamka" as const,
  source: "vlastne" as const,
  title: "Schôdzka v stredu",
  details: "o 10:00",
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

it("prázdny zoznam zobrazí informačnú vetu (po označení videných)", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([]);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenia-empty");
  await waitFor(() => {
    expect(markUpozorneniaSeen).toHaveBeenCalledTimes(1);
  });
});

it("zobrazí kartu s 'Nové' štítkom pre nevidenú kartu", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([VLASTNA_KARTA]);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-own-1");
  expect(screen.getByTestId("upozornenie-nove-own-1").textContent).toBe("Nové");
  expect(screen.getByText("Schôdzka v stredu")).toBeTruthy();
  expect(screen.getByText("o 10:00")).toBeTruthy();
});

it("rola 'citanie' vidí zoznam, ale NEVIDÍ žiadne akčné tlačidlá ani formulár", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([VLASTNA_KARTA]);
  render(<UpozorneniaSection role="citanie" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-own-1");
  expect(screen.queryByTestId("upozornenie-new")).toBeNull();
  expect(screen.queryByTestId("upozornenie-resolve-own-1")).toBeNull();
  expect(screen.queryByTestId("upozornenie-edit-own-1")).toBeNull();
});

it("karta zo zdroja 'appka' nemá Upraviť/Zmazať, len Vybavené/Odložiť", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([{ ...VLASTNA_KARTA, id: "appka-1", source: "appka" as const }]);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-appka-1");
  expect(screen.getByTestId("upozornenie-resolve-appka-1")).toBeTruthy();
  expect(screen.queryByTestId("upozornenie-edit-appka-1")).toBeNull();
  expect(screen.queryByTestId("upozornenie-delete-appka-1")).toBeNull();
});

it("'+ Nové upozornenie' otvorí formulár, uloženie zavolá createOwnNote a znova načíta zoznam", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  // Tretie `[]` je issue 267 follow-up gap 3's doplnkový najširší dopyt,
  // ktorý `load()` spraví, keď je zoznam prázdny (tu: hneď po mounte).
  fetchUpozornenia.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([VLASTNA_KARTA]);
  createOwnNote.mockResolvedValue(undefined);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenia-empty");

  fireEvent.click(screen.getByTestId("upozornenie-new"));
  fireEvent.change(screen.getByTestId("upozornenie-form-title"), { target: { value: "Schôdzka v stredu" } });
  fireEvent.change(screen.getByTestId("upozornenie-form-details"), { target: { value: "o 10:00" } });
  fireEvent.click(screen.getByTestId("upozornenie-form-save"));

  await waitFor(() => {
    expect(createOwnNote).toHaveBeenCalledWith({ title: "Schôdzka v stredu", details: "o 10:00", dueAt: null });
  });
  await screen.findByTestId("upozornenie-own-1");
});

it("klik na 'Vybavené' zavolá resolveUpozornenie a znova načíta zoznam", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValueOnce([VLASTNA_KARTA]).mockResolvedValueOnce([{ ...VLASTNA_KARTA, status: "vybavene" as const }]);
  resolveUpozornenie.mockResolvedValue(undefined);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-own-1");

  fireEvent.click(screen.getByTestId("upozornenie-resolve-own-1"));
  await waitFor(() => {
    expect(resolveUpozornenie).toHaveBeenCalledWith("own-1");
  });
});

it("Upraviť predvyplní formulár existujúcimi hodnotami vlastnej poznámky", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([VLASTNA_KARTA]);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-own-1");

  fireEvent.click(screen.getByTestId("upozornenie-edit-own-1"));
  expect(screen.getByTestId<HTMLInputElement>("upozornenie-form-title").value).toBe("Schôdzka v stredu");
  expect(screen.getByTestId<HTMLTextAreaElement>("upozornenie-form-details").value).toBe("o 10:00");
});

it("Zmazať zavolá deleteOwnNote a znova načíta zoznam", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  // Tretie `[]` je issue 267 follow-up gap 3's doplnkový najširší dopyt,
  // ktorý `load()` spraví, keď je zoznam prázdny (tu: po zmazaní).
  fetchUpozornenia.mockResolvedValueOnce([VLASTNA_KARTA]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  deleteOwnNote.mockResolvedValue(undefined);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-own-1");

  fireEvent.click(screen.getByTestId("upozornenie-delete-own-1"));
  await waitFor(() => {
    expect(deleteOwnNote).toHaveBeenCalledWith("own-1");
  });
  await screen.findByTestId("upozornenia-empty");
});
