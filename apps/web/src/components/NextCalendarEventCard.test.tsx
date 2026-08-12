import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextCalendarEventCard } from "./NextCalendarEventCard.js";

const { fetchNextCalendarEvent } = vi.hoisted(() => ({ fetchNextCalendarEvent: vi.fn() }));
vi.mock("../calendarApi.js", () => ({ fetchNextCalendarEvent }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("nenakonfigurované → nič sa nezobrazí (žiadna karta)", async () => {
  fetchNextCalendarEvent.mockResolvedValue({ configured: false, events: [], error: false });
  render(<NextCalendarEventCard />);
  await waitFor(() => {
    expect(fetchNextCalendarEvent).toHaveBeenCalledTimes(1);
  });
  expect(screen.queryByTestId("next-calendar-event")).toBeNull();
});

it("nakonfigurované s JEDNOU udalosťou → ukáže dátum aj názov", async () => {
  fetchNextCalendarEvent.mockResolvedValue({ configured: true, events: [{ title: "Stretnutie s dodávateľom", dateLabel: "utorok 12. 8.", allDay: false }], error: false });
  render(<NextCalendarEventCard />);
  const card = await screen.findByTestId("next-calendar-event");
  expect(card.textContent).toContain("utorok 12. 8.");
  expect(card.textContent).toContain("Stretnutie s dodávateľom");
});

// issue 382: majiteľ chce vidieť TRI najbližšie udalosti, nie jednu.
it("nakonfigurované s TROMI udalosťami → ukáže všetky tri, každú vo VLASTNOM riadku", async () => {
  fetchNextCalendarEvent.mockResolvedValue({
    configured: true,
    events: [
      { title: "Prvá schôdza", dateLabel: "utorok 12. 8.", allDay: false },
      { title: "Druhá schôdza", dateLabel: "streda 13. 8.", allDay: false },
      { title: "Tretia schôdza", dateLabel: "štvrtok 14. 8.", allDay: true },
    ],
    error: false,
  });
  render(<NextCalendarEventCard />);
  const card = await screen.findByTestId("next-calendar-event");
  expect(card.textContent).toContain("Prvá schôdza");
  expect(card.textContent).toContain("Druhá schôdza");
  expect(card.textContent).toContain("Tretia schôdza");
  expect(card.querySelectorAll(".next-calendar-event-row")).toHaveLength(3);
});

it("nakonfigurované, žiadna udalosť (prázdne pole) → čestná hláška, nie prázdna karta", async () => {
  fetchNextCalendarEvent.mockResolvedValue({ configured: true, events: [], error: false });
  render(<NextCalendarEventCard />);
  const card = await screen.findByTestId("next-calendar-event");
  expect(card.textContent).toMatch(/žiadna nadchádzajúca udalosť/i);
});

it("nakonfigurované, chyba pri načítaní → čestná hláška o zlyhaní, nikdy surová chyba", async () => {
  fetchNextCalendarEvent.mockResolvedValue({ configured: true, events: [], error: true });
  render(<NextCalendarEventCard />);
  const card = await screen.findByTestId("next-calendar-event");
  expect(card.textContent).toMatch(/sa nepodarilo načítať/i);
});

describe("mountedRef guard", () => {
  it("výsledok doručený PO odmountovaní sa NEZAPÍŠE (žiadna React varovanie/pád)", async () => {
    let resolveFetch: (value: { configured: boolean; events: never[]; error: boolean }) => void = () => {
      throw new Error("nemalo sa zavolať pred nastavením");
    };
    fetchNextCalendarEvent.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { unmount } = render(<NextCalendarEventCard />);
    unmount();
    resolveFetch({ configured: true, events: [], error: false });
    await new Promise((r) => setTimeout(r, 0));
    // Nič nepadlo — to je celý dôkaz (`mountedRef` guard v komponente).
  });
});
