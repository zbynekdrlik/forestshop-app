// issue 309: fasáda pre HTTP vrstvu — spája fetch (sieť) + parse (next-
// event.ts) + krátkodobú in-memory cache. FAKTÓROVÁ funkcia (nie modulový
// singleton) — každé volanie dostane VLASTNÝ uzáver so stavom cache, takže
// testy sa navzájom nemôžu ovplyvniť bez potreby vlastného "reset" exportu
// (rovnaká úvaha ako prečo `UpozorneniaSection.test.tsx` čistí
// `localStorage` v `afterEach` — tu sa tomu vyhýbame úplne, nový uzáver na
// test).

import { log } from "../../logger.js";
import type { IcsFetcher } from "./fetcher.js";
import { resolveNextEvents, type NextCalendarEvent } from "./next-event.js";
import { NEXT_EVENT_DAYS_LIMIT, NEXT_EVENT_ERROR_CACHE_TTL_MS, NEXT_EVENT_OK_CACHE_TTL_MS } from "./constants.js";

// issue 382 → 439: pole namiesto singulárnej udalosti — majiteľ chce
// udalosti z TROCH najbližších dní s udalosťami (`NEXT_EVENT_DAYS_LIMIT`).
export type NextEventResult = { readonly ok: true; readonly events: readonly NextCalendarEvent[] } | { readonly ok: false };

export interface NextEventService {
  getNextEvent(now: Date): Promise<NextEventResult>;
}

interface CacheEntry {
  readonly result: NextEventResult;
  readonly cachedAtMs: number;
  readonly ttlMs: number;
}

export function createNextEventService(fetchIcs: IcsFetcher): NextEventService {
  let cache: CacheEntry | undefined;
  // Zdieľaný prísľub pre súbežné volania POČAS jedného fetchu — appka má
  // dnes jediného čitateľa, ale je to lacná poistka proti zbytočnému
  // zdvojenému sťahovaniu, keby sa nástenka niekedy otvorila vo viacerých
  // kartách naraz.
  let inFlight: Promise<CacheEntry> | undefined;

  async function refresh(now: Date): Promise<CacheEntry> {
    try {
      const icsText = await fetchIcs();
      const events = resolveNextEvents(icsText, now, NEXT_EVENT_DAYS_LIMIT);
      return { result: { ok: true, events }, cachedAtMs: now.getTime(), ttlMs: NEXT_EVENT_OK_CACHE_TTL_MS };
    } catch (error) {
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      // Chybová hláška NIKDY neobsahuje URL (`fetcher.ts`'s vlastný
      // komentár) — bezpečné logovať priamo, žiadne prekrývanie navyše.
      log.error({ rawErrorMessage }, "Google kalendár: nepodarilo sa načítať/spracovať najbližšiu udalosť");
      return { result: { ok: false }, cachedAtMs: now.getTime(), ttlMs: NEXT_EVENT_ERROR_CACHE_TTL_MS };
    }
  }

  return {
    async getNextEvent(now: Date): Promise<NextEventResult> {
      if (cache !== undefined && now.getTime() - cache.cachedAtMs < cache.ttlMs) {
        return cache.result;
      }
      if (inFlight === undefined) {
        inFlight = refresh(now).finally(() => {
          inFlight = undefined;
        });
      }
      const entry = await inFlight;
      cache = entry;
      return entry.result;
    },
  };
}
