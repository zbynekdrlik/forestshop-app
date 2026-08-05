import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UpozornenieRow } from "../upozorneniaApi.js";
import { UpozorneniaSection } from "./UpozorneniaSection.js";

// issue 267 (živé overenie, gap 3): prázdny zoznam tvrdil natvrdo "všetko je
// vybavené" bez ohľadu na to, PREČO je prázdny — aj keď jediná existujúca
// karta bola len ODLOŽENÁ. Tieto testy overujú, že hláška zodpovedá
// SKUTOČNEJ príčine (nič vôbec / všetko vybavené / všetko odložené /
// kombinácia), zisťovanej doplnkovým najširším dopytom LEN keď je zoznam
// prázdny.

const { fetchUpozornenia, markUpozorneniaSeen } = vi.hoisted(() => ({
  fetchUpozornenia: vi.fn(),
  markUpozorneniaSeen: vi.fn(),
}));

vi.mock("../upozorneniaApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../upozorneniaApi.js")>();
  return { ...actual, fetchUpozornenia, markUpozorneniaSeen };
});

function karta(id: string, status: UpozornenieRow["status"]): UpozornenieRow {
  return {
    id,
    type: "vlastna_poznamka",
    source: "vlastne",
    title: `Karta ${id}`,
    details: "",
    link: null,
    dueAt: null,
    postponedUntil: status === "odlozene" ? "2099-01-01T00:00:00.000Z" : null,
    seenAt: "2026-08-05T08:00:00.000Z",
    resolvedAt: status === "vybavene" ? "2026-08-05T08:00:00.000Z" : null,
    createdAt: "2026-08-05T08:00:00.000Z",
    status,
  };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("skutočne nič nie je zapísané — hláška to hovorí pravdivo", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockResolvedValue([]);
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  const empty = await screen.findByTestId("upozornenia-empty");
  expect(empty.textContent).toBe("Žiadne upozornenia — nič nie je zapísané.");
});

it("existuje len VYBAVENÁ karta — hláška to hovorí pravdivo (nie 'nič nie je zapísané')", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockImplementation((filter: { readonly includeResolved: boolean; readonly includePostponed?: boolean }) => {
    if (filter.includeResolved && filter.includePostponed === true) return Promise.resolve([karta("a", "vybavene")]);
    return Promise.resolve([]);
  });
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  const empty = await screen.findByTestId("upozornenia-empty");
  expect(empty.textContent).toBe("Žiadne upozornenia — všetko je vybavené.");
});

it("existuje len ODLOŽENÁ karta — hláška hovorí 'odložené', NIKDY 'vybavené' (živý nález)", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockImplementation((filter: { readonly includeResolved: boolean; readonly includePostponed?: boolean }) => {
    if (filter.includeResolved && filter.includePostponed === true) return Promise.resolve([karta("b", "odlozene")]);
    return Promise.resolve([]);
  });
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  const empty = await screen.findByTestId("upozornenia-empty");
  expect(empty.textContent).toBe("Žiadne upozornenia — všetko je odložené.");
});

it("existujú OBE (vybavená aj odložená) — hláška nehádže žiadnu konkrétnu nepravdivú príčinu", async () => {
  markUpozorneniaSeen.mockResolvedValue(undefined);
  fetchUpozornenia.mockImplementation((filter: { readonly includeResolved: boolean; readonly includePostponed?: boolean }) => {
    if (filter.includeResolved && filter.includePostponed === true) return Promise.resolve([karta("c", "vybavene"), karta("d", "odlozene")]);
    return Promise.resolve([]);
  });
  render(<UpozorneniaSection role="manazer" onSessionExpired={vi.fn()} />);
  const empty = await screen.findByTestId("upozornenia-empty");
  expect(empty.textContent).toBe("Žiadne upozornenia v tomto zobrazení — zvyšné sú vybavené alebo odložené.");
});
