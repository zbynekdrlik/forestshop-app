import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchNextCalendarEvent } from "./calendarApi.js";

// issue 309: appka NIKDY sama nekontaktuje Google — `fetch` je vždy
// stubovaná proti PRIAMEMU `/api/upozornenia/next-event`.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("fetchNextCalendarEvent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("nenakonfigurované → configured:false, events:[]", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ configured: false, events: [], error: false })));
    await expect(fetchNextCalendarEvent()).resolves.toEqual({ configured: false, events: [], error: false });
  });

  // issue 382: majiteľ chce TRI najbližšie udalosti — server posiela pole,
  // klient ho vráti presne tak, ako prišlo (žiadne orezanie na klientovi).
  it("nakonfigurované s TROMI udalosťami → vráti pole presne tak, ako ho poslal server", async () => {
    const body = {
      configured: true,
      events: [
        { title: "Prvá", dateLabel: "utorok 12. 8.", allDay: false },
        { title: "Druhá", dateLabel: "streda 13. 8.", allDay: false },
        { title: "Tretia", dateLabel: "štvrtok 14. 8.", allDay: true },
      ],
      error: false,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    await expect(fetchNextCalendarEvent()).resolves.toEqual(body);
  });

  it("401 (vypršaná relácia) sa NIKDY nezobrazí ako chyba — bezpečný default", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "Neprihlásený" }, 401)));
    await expect(fetchNextCalendarEvent()).resolves.toEqual({ configured: false, events: [], error: false });
  });

  it("sieťová chyba (fetch vyhodí) sa NIKDY nepropaguje ďalej — bezpečný default", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(fetchNextCalendarEvent()).resolves.toEqual({ configured: false, events: [], error: false });
  });

  it("nevalidná odpoveď (zlý tvar JSON) sa NIKDY nepropaguje ďalej — bezpečný default", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ nezmysel: true })));
    await expect(fetchNextCalendarEvent()).resolves.toEqual({ configured: false, events: [], error: false });
  });
});
