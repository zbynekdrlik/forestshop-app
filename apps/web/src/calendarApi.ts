import { z } from "zod";

// issue 309: "Eshop → Upozornenia" — najbližšia udalosť z Google kalendára.
// Samostatný modul od `upozorneniaApi.ts` (rovnaký dôvod ako na strane API
// — nie DB-backed "upozornenie", nezávislý read-through pohľad).

const nextEventSchema = z.object({
  configured: z.boolean(),
  event: z.object({ title: z.string(), dateLabel: z.string(), allDay: z.boolean() }).nullable(),
  error: z.boolean(),
});
export type NextCalendarEventResult = z.infer<typeof nextEventSchema>;

// Bezpečný "nič nezobrazovať" default — na 401 (vypršaná relácia) aj na
// akúkoľvek sieťovú/parse chybu. Táto karta je len doplnkový glance na
// nástenke, nikdy nesmie zablokovať/zobraziť chybu namiesto zvyšku
// "Upozornenia" (rovnaký princíp ako `fetchUpozorneniaCount`'s tolerantný
// bezpečný default).
const UNAVAILABLE: NextCalendarEventResult = { configured: false, event: null, error: false };

export async function fetchNextCalendarEvent(): Promise<NextCalendarEventResult> {
  try {
    const response = await fetch("/api/upozornenia/next-event");
    if (!response.ok) return UNAVAILABLE;
    const parsed = nextEventSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}
