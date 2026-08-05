import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UpozorneniaSection } from "./UpozorneniaSection.js";

// issue 267 (živé overenie, gap 2): odložená karta bola neviditeľná ÚPLNE
// VŽDY a nedala sa vrátiť — nový checkbox "aj odložené" (nezávislý od "aj
// vybavené") odkryje ju, nové tlačidlo "Zrušiť odloženie" ju vráti naspäť.

const { fetchUpozornenia, markUpozorneniaSeen, cancelPostponeUpozornenie } = vi.hoisted(() => ({
  fetchUpozornenia: vi.fn(),
  markUpozorneniaSeen: vi.fn(),
  cancelPostponeUpozornenie: vi.fn(),
}));

vi.mock("../upozorneniaApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../upozorneniaApi.js")>();
  return { ...actual, fetchUpozornenia, markUpozorneniaSeen, cancelPostponeUpozornenie };
});

const ODLOZENA_KARTA = {
  id: "postponed-1",
  type: "vlastna_poznamka" as const,
  source: "vlastne" as const,
  title: "Odložená karta",
  details: "",
  link: null,
  dueAt: null,
  postponedUntil: "2026-08-20T00:00:00.000Z",
  seenAt: "2026-08-05T08:00:00.000Z",
  resolvedAt: null,
  createdAt: "2026-08-05T08:00:00.000Z",
  status: "odlozene" as const,
};

const OTVORENA_KARTA = { ...ODLOZENA_KARTA, id: "open-1", title: "Otvorená karta", postponedUntil: null, status: "otvorene" as const };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("zaškrtnutie 'aj odložené' znova načíta zoznam s includePostponed: true", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([]);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenia-empty");

  fireEvent.click(screen.getByLabelText("aj odložené"));

  // `toHaveBeenCalledWith` (nie `toHaveBeenLastCalledWith`) — issue 267
  // follow-up gap 3's doplnkový najširší klasifikačný dopyt (spustený, lebo
  // zoznam je prázdny) môže dobehnúť AŽ PO tomto volaní, takže "posledné"
  // volanie nie je deterministicky toto.
  await waitFor(() => {
    expect(fetchUpozornenia).toHaveBeenCalledWith({ includeResolved: false, includePostponed: true });
  });
});

it("otvorená (nie odložená) karta NEMÁ tlačidlo 'Zrušiť odloženie'", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([OTVORENA_KARTA]);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-open-1");
  expect(screen.queryByTestId("upozornenie-cancel-postpone-open-1")).toBeNull();
});

it("odložená karta má tlačidlo 'Zrušiť odloženie', klik zavolá cancelPostponeUpozornenie a znova načíta zoznam", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValueOnce([ODLOZENA_KARTA]).mockResolvedValueOnce([{ ...ODLOZENA_KARTA, status: "otvorene" as const, postponedUntil: null }]);
  cancelPostponeUpozornenie.mockResolvedValue(undefined);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  await screen.findByTestId("upozornenie-postponed-1");

  fireEvent.click(screen.getByTestId("upozornenie-cancel-postpone-postponed-1"));
  await waitFor(() => {
    expect(cancelPostponeUpozornenie).toHaveBeenCalledWith("postponed-1");
  });
});
