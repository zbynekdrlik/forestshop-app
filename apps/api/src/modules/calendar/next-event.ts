// issue 309: čistá (bez siete/DB) logika "ktorá udalosť je najbližšia
// nadchádzajúca" nad už stiahnutým ICS textom — testovateľná fixtúrami,
// nikdy proti skutočnému Google.

import ical, { type ParameterValue } from "node-ical";
import { getZonedDateParts, zonedDateKey } from "../../timezone.js";
import { RECURRENCE_EXPANSION_WINDOW_DAYS } from "./constants.js";

export interface NextCalendarEvent {
  readonly title: string;
  /** Predformátovaný Slovenský popis, napr. "utorok 12. 8." — appka má na
   * server aj klient JEDEN zdroj pravdy pre formát, žiadna duplicitná
   * formátovacia logika na frontende. */
  readonly dateLabel: string;
  readonly allDay: boolean;
}

const WEEKDAY_FORMAT = new Intl.DateTimeFormat("sk-SK", { timeZone: "Europe/Bratislava", weekday: "long" });

function formatDateLabel(instant: Date): string {
  const { day, month } = getZonedDateParts(instant);
  return `${WEEKDAY_FORMAT.format(instant)} ${String(day)}. ${String(month)}.`;
}

function textOf(value: ParameterValue): string {
  return typeof value === "string" ? value : value.val;
}

interface Candidate {
  readonly start: Date;
  readonly end: Date;
  readonly title: string;
  readonly allDay: boolean;
}

/**
 * Udalosť "neskončila" — pri celodennej (plávajúcej, bez TZID) sa porovnáva
 * kalendárny DEŇ v Europe/Bratislava (`zonedDateKey`, `end` je exkluzívna
 * hranica — deň PO poslednom dni udalosti), nikdy holý UTC okamih: node-ical
 * interpretuje `VALUE=DATE` podľa TZ BEŽIACEHO PROCESU (overené priamo —
 * rovnaký vstup dá iný UTC okamih pod `TZ=UTC` než pod `TZ=Europe/Prague`),
 * čo by CI (bežiace v UTC) a produkciu (`TZ=Europe/Bratislava`, issue 293)
 * mohlo ticho rozísť pri porovnaní holých okamihov — `zonedDateKey` je voči
 * tomu odolné, lebo Bratislava je vždy 0 až +2 h pred UTC, takže spätné
 * preformátovanie VŽDY pristane na tom istom kalendárnom dni bez ohľadu na
 * to, v akom pásme node-ical pôvodne interpretovalo plávajúci dátum.
 * Časovaná (TZID) udalosť porovnáva PRIAMO okamihy — tie sú jednoznačné.
 */
function hasNotEnded(candidate: Candidate, now: Date): boolean {
  if (candidate.allDay) return zonedDateKey(candidate.end) > zonedDateKey(now);
  return candidate.end.getTime() > now.getTime();
}

/**
 * `ical.sync.parseICS` NIKDY nehodí výnimku, ani na úplne nezmyselný vstup —
 * overené priamo (node-ical 0.27.1, prázdny aj náhodný text obidva vrátia
 * `{}`). Appka preto potrebuje VLASTNÚ minimálnu kontrolu "vyzerá to vôbec
 * ako kalendár" — inak by pokazený/nekalendárový feed (napr. HTML chybová
 * stránka vrátená s HTTP 200) ticho vyzeral ako "žiadna nadchádzajúca
 * udalosť" namiesto toho, aby nahlas zlyhal (dispatch: "Fetch failure /
 * malformed feed → fail loud, never crash, never show raw error").
 */
export function resolveNextEvent(icsText: string, now: Date): NextCalendarEvent | null {
  if (!icsText.includes("BEGIN:VCALENDAR")) {
    throw new Error("Stiahnutý obsah nevyzerá ako platný ICS kalendár (chýba BEGIN:VCALENDAR)");
  }

  const parsed = ical.sync.parseICS(icsText);
  const from = now;
  const to = new Date(now.getTime() + RECURRENCE_EXPANSION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const candidates: Candidate[] = [];
  for (const component of Object.values(parsed)) {
    if (component === undefined || component.type !== "VEVENT") continue;
    const event = component;
    if (event.status === "CANCELLED") continue;
    // `expandRecurringEvent` funguje pre OBIDVA prípady (opakujúca sa aj
    // jednorazová udalosť) — jednotná cesta, žiadna samostatná vetva pre
    // "nemá rrule" (README: "Works with both recurring and non-recurring
    // events"), navyše správne zohľadní EXDATE/RECURRENCE-ID.
    const instances = ical.expandRecurringEvent(event, { from, to, expandOngoing: true });
    for (const instance of instances) {
      if (instance.event.status === "CANCELLED") continue;
      candidates.push({ start: instance.start, end: instance.end, title: textOf(instance.summary), allDay: instance.isFullDay });
    }
  }

  const upcoming = candidates.filter((c) => hasNotEnded(c, now)).sort((a, b) => a.start.getTime() - b.start.getTime());
  const next = upcoming[0];
  if (next === undefined) return null;
  return { title: next.title, dateLabel: formatDateLabel(next.start), allDay: next.allDay };
}
