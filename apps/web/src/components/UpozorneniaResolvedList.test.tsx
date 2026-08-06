import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UpozorneniaResolvedList } from "./UpozorneniaResolvedList.js";

// issue 283: záložka "Vybavené" — komponentové testy pre históriu vybavených
// kariet + vrátenie späť medzi otvorené.

const { fetchResolvedUpozornenia, returnUpozornenieToOpen } = vi.hoisted(() => ({
  fetchResolvedUpozornenia: vi.fn(),
  returnUpozornenieToOpen: vi.fn(),
}));

// `UpozorneniaUnauthorizedError` ostáva SKUTOČNÁ trieda (rovnaký dôvod ako
// `UpozorneniaSection.test.tsx` — `instanceof` v komponente musí fungovať).
vi.mock("../upozorneniaApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../upozorneniaApi.js")>();
  return { ...actual, fetchResolvedUpozornenia, returnUpozornenieToOpen };
});

const RESOLVED_MANUAL = {
  id: "resolved-1",
  type: "vlastna_poznamka" as const,
  source: "vlastne" as const,
  title: "Omylom vybavená",
  details: "",
  link: null,
  dueAt: null,
  postponedUntil: null,
  seenAt: "2026-08-05T08:00:00.000Z",
  resolvedAt: "2026-08-06T09:00:00.000Z",
  createdAt: "2026-08-05T08:00:00.000Z",
  status: "vybavene" as const,
  resolvedByName: "Majiteľ",
};

const RESOLVED_AUTO = {
  id: "resolved-2",
  type: "nevyzdvihnuta_zasielka" as const,
  source: "appka" as const,
  title: "Zásielka vyzdvihnutá",
  details: "",
  link: null,
  dueAt: null,
  postponedUntil: null,
  seenAt: "2026-08-05T08:00:00.000Z",
  resolvedAt: "2026-08-06T09:00:00.000Z",
  createdAt: "2026-08-05T08:00:00.000Z",
  status: "vybavene" as const,
  resolvedByName: null,
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("prázdny zoznam zobrazí informačnú vetu", async () => {
  fetchResolvedUpozornenia.mockResolvedValue([]);
  render(<UpozorneniaResolvedList canControl={true} onSessionExpired={vi.fn()} onReturnedToOpen={vi.fn()} />);
  await screen.findByTestId("upozornenia-resolved-empty");
});

it("zobrazí meno toho, kto vybavil, a 'automaticky' pre kartu bez resolvedByName", async () => {
  fetchResolvedUpozornenia.mockResolvedValue([RESOLVED_MANUAL, RESOLVED_AUTO]);
  render(<UpozorneniaResolvedList canControl={true} onSessionExpired={vi.fn()} onReturnedToOpen={vi.fn()} />);
  await screen.findByTestId("upozornenie-resolved-resolved-1");

  expect(screen.getByTestId("upozornenie-resolved-meta-resolved-1").textContent).toContain("Majiteľ");
  expect(screen.getByTestId("upozornenie-resolved-meta-resolved-2").textContent).toContain("automaticky");
});

it("rola 'citanie' vidí zoznam, ale NEVIDÍ tlačidlo 'Vrátiť medzi otvorené'", async () => {
  fetchResolvedUpozornenia.mockResolvedValue([RESOLVED_MANUAL]);
  render(<UpozorneniaResolvedList canControl={false} onSessionExpired={vi.fn()} onReturnedToOpen={vi.fn()} />);
  await screen.findByTestId("upozornenie-resolved-resolved-1");
  expect(screen.queryByTestId("upozornenie-return-resolved-1")).toBeNull();
});

it("klik na 'Vrátiť medzi otvorené' zavolá returnUpozornenieToOpen, znova načíta zoznam a upovedomí rodiča", async () => {
  fetchResolvedUpozornenia.mockResolvedValueOnce([RESOLVED_MANUAL]).mockResolvedValueOnce([]);
  returnUpozornenieToOpen.mockResolvedValue("returned");
  const onReturnedToOpen = vi.fn();
  render(<UpozorneniaResolvedList canControl={true} onSessionExpired={vi.fn()} onReturnedToOpen={onReturnedToOpen} />);
  await screen.findByTestId("upozornenie-resolved-resolved-1");

  fireEvent.click(screen.getByTestId("upozornenie-return-resolved-1"));
  await waitFor(() => {
    expect(returnUpozornenieToOpen).toHaveBeenCalledWith("resolved-1");
  });
  await waitFor(() => {
    expect(onReturnedToOpen).toHaveBeenCalledTimes(1);
  });
  await screen.findByTestId("upozornenia-resolved-empty");
});

it("kolízia zobrazí zrozumiteľnú Slovak hlášku, karta OSTÁVA v zozname, rodič sa neupovedomí", async () => {
  fetchResolvedUpozornenia.mockResolvedValue([RESOLVED_MANUAL]);
  returnUpozornenieToOpen.mockResolvedValue("collision");
  const onReturnedToOpen = vi.fn();
  render(<UpozorneniaResolvedList canControl={true} onSessionExpired={vi.fn()} onReturnedToOpen={onReturnedToOpen} />);
  await screen.findByTestId("upozornenie-resolved-resolved-1");

  fireEvent.click(screen.getByTestId("upozornenie-return-resolved-1"));
  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toContain("už otvorená karta existuje");
  });
  expect(onReturnedToOpen).not.toHaveBeenCalled();
  expect(screen.getByTestId("upozornenie-resolved-resolved-1")).toBeTruthy();
});
