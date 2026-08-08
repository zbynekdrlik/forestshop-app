// issue 309: sťahovanie majiteľovej tajnej Google kalendár ICS adresy.
//
// NA ROZDIEL od `catalog/fetcher.ts`'s `redactUrl` (prekrýva LEN query
// parametre — Shoptet nesie svoj `hash` tam) je táto adresa CELÁ tajomstvo:
// Google-ova súkromná ICS adresa má tajný token PRIAMO V CESTE
// (`/calendar/ical/<email>/private-<token>/basic.ics`). `redactUrl` by tu
// teda nič neskryl. Preto sa URL NIKDY neinterpoluje do žiadnej chybovej
// hlášky (ani prekrytá) — chyby nesú len status kód/typ zlyhania.

import { readBounded } from "../catalog/fetcher.js";
import { ICS_FETCH_TIMEOUT_MS, MAX_ICS_BYTES } from "./constants.js";

export type IcsFetcher = () => Promise<string>;

export function createHttpIcsFetcher(url: string): IcsFetcher {
  return async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, ICS_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Google kalendár vrátil HTTP ${String(response.status)}`);
      }
      const body = await readBounded(response, MAX_ICS_BYTES);
      return body.toString("utf8");
    } finally {
      clearTimeout(timer);
    }
  };
}
