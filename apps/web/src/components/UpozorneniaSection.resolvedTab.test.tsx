import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UpozorneniaSection } from "./UpozorneniaSection.js";

// issue 283 (majiteľ, komentár na tickete): záložka "Vybavené" — prepínanie
// medzi "Otvorené" (predvolené) a "Vybavené", vydelené do VLASTNÉHO súboru
// (`UpozorneniaSection.test.tsx` je už na hranici, rovnaký vzor ako
// `.badgeRefresh`/`.emptyMessage`/`.postponeVisibility` súbory vedľa neho).

const { fetchUpozornenia, markUpozorneniaSeen, fetchResolvedUpozornenia } = vi.hoisted(() => ({
  fetchUpozornenia: vi.fn(),
  markUpozorneniaSeen: vi.fn(),
  fetchResolvedUpozornenia: vi.fn(),
}));

vi.mock("../upozorneniaApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../upozorneniaApi.js")>();
  return { ...actual, fetchUpozornenia, markUpozorneniaSeen, fetchResolvedUpozornenia };
});

const VLASTNA_KARTA = {
  id: "own-1",
  type: "vlastna_poznamka" as const,
  source: "vlastne" as const,
  title: "Schôdzka v stredu",
  details: "",
  link: null,
  dueAt: null,
  postponedUntil: null,
  seenAt: "2026-08-05T08:00:00.000Z",
  resolvedAt: null,
  createdAt: "2026-08-05T08:00:00.000Z",
  status: "otvorene" as const,
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("predvolená záložka je 'Otvorené' — zobrazí otvorený zoznam, nevolá fetchResolvedUpozornenia", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([VLASTNA_KARTA]);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-own-1");

  expect(screen.getByTestId("upozornenia-tab-otvorene").getAttribute("aria-selected")).toBe("true");
  expect(screen.getByTestId("upozornenia-tab-vybavene").getAttribute("aria-selected")).toBe("false");
  expect(fetchResolvedUpozornenia).not.toHaveBeenCalled();
});

it("klik na záložku 'Vybavené' zobrazí históriu vybavených kariet, otvorený zoznam sa skryje", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([VLASTNA_KARTA]);
  fetchResolvedUpozornenia.mockResolvedValue([]);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-own-1");

  fireEvent.click(screen.getByTestId("upozornenia-tab-vybavene"));
  await waitFor(() => {
    expect(fetchResolvedUpozornenia).toHaveBeenCalledTimes(1);
  });
  await screen.findByTestId("upozornenia-resolved-empty");
  expect(screen.queryByTestId("upozornenie-own-1")).toBeNull();

  fireEvent.click(screen.getByTestId("upozornenia-tab-otvorene"));
  await screen.findByTestId("upozornenie-own-1");
});

// Code review: pôvodná verzia gatovala CELÚ sekciu (vrátane prepínača
// záložiek) na "Otvorené" zoznam ešte NAČÍTANÝM/BEZ CHYBY — kým "Otvorené"
// ešte len načítavalo (alebo sieťovo zlyhalo), obsluha sa NEDOSTALA ani k
// nezávislej záložke "Vybavené". Tento test dokazuje OBIDVA prípady priamo
// (dočasné vrátenie starej gaty na oba prípady spadlo presne tu, návrat
// opravy prešiel znova — `regression-test-first.md`'s obojsmerné overenie).
it("prepínač záložiek je dostupný AJ kým sa 'Otvorené' ešte len načítava", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockReturnValue(new Promise(() => {})); // nikdy sa nevyrieši — simuluje "ešte načítava"
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);

  await screen.findByTestId("upozornenia-tab-vybavene");
  expect(screen.getByText("Načítavam…")).toBeTruthy();
});

it("prepínač záložiek je dostupný AJ keď 'Otvorené' zlyhá sieťovou chybou", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockRejectedValue(new Error("sieťový výpadok"));
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);

  await screen.findByTestId("upozornenia-tab-vybavene");
  expect(screen.getByRole("alert").textContent).toBe("Upozornenia sa nepodarilo načítať.");
});
