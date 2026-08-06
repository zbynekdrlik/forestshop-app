// Zdieľané jadro pre prácu s Europe/Bratislava časovým pásmom — DST-vedomé,
// založené na vstavanom `Intl.DateTimeFormat` (Node 24 má plné ICU aj IANA
// databázu zón), žiadna závislosť navyše. Issue 293: appka (aj kontajner)
// dovtedy počítala dátumy/čas v UTC, takže naplánované úlohy behali o 1-2
// hodiny neskôr, než majiteľ nastavil, a pár obrazoviek ukazovalo dátum v
// nečitateľnom UTC tvare namiesto slovenského. Predtým existovali DVE
// samostatné implementácie toho istého triku (`modules/orders/parser.ts`'s
// `parseShopLocalDateTime`, `modules/orders/overview.ts`'s
// `computeBratislavaPeriodBoundaries`) — tento modul je JEDNO spoločné
// miesto na koreňovej `src/` úrovni (rovnaká úroveň ako `logger.ts`/
// `env.ts` — cross-cutting utilita, nepatrí žiadnemu konkrétnemu
// `modules/*`), obe znovu použijú `getZonedDateParts` namiesto duplicitného
// `Intl.DateTimeFormat` volania.

export const BRATISLAVA_TIME_ZONE = "Europe/Bratislava";

export interface ZonedDateParts {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** Rozloží UTC okamih na kalendárne/časové zložky v danom pásme (predvolene
 * Europe/Bratislava). */
export function getZonedDateParts(instant: Date, timeZone: string = BRATISLAVA_TIME_ZONE): ZonedDateParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** "YYYY-MM-DD" kalendárny dátum v danom pásme — pre DB `date` stĺpce a pre
 * "raz za deň" rozvrhové kľúče. NIKDY `toISOString().slice(0, 10)` (to je
 * vždy UTC deň — presne issue 293's chyba: čokoľvek medzi 22:00 a polnocou
 * slovenského času vyjde s dátumom VČEREJŠKA). */
export function zonedDateKey(instant: Date, timeZone: string = BRATISLAVA_TIME_ZONE): string {
  const { year, month, day } = getZonedDateParts(instant, timeZone);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}
