// issue 422 — "Živé ceny/dostupnosť" (dodávateľská strana): lazy live-fetch
// analóg starej appky's `/api/images` endpointu. Sieťová hranica ide
// VÝHRADNE cez `SearchClient.fetchPage` (zdieľaný cookie jar/warm-up/
// throttle so `.search()` volaniami toho istého klienta, design komentár
// na tickete) — NIKDY priamy `fetch`. Dispatch cez `adapterForUrl` (host
// lookup) na jednu z troch dodávateľských extrakcií (`adapters/*.ts`'s
// `extractDetailMeta`); URL mimo troch známych adaptérov degraduje TICHO
// na "žiadne info", bez akéhokoľvek sieťového volania (zámerné zúženie
// rozsahu, design komentár: `chosenCandidate`/top-8 panel kandidáti sú
// VŽDY adaptérového pôvodu — jediný degradovaný prípad je zriedkavá plne
// ručne zadaná linka od neznámeho dodávateľa).

import { log } from "../../logger.js";
import { adapterForUrl } from "./adapters/registry.js";
import type { SupplierDetailMeta } from "./adapters/types.js";
import type { SearchClient } from "./client.js";

const EMPTY_META: SupplierDetailMeta = { price: null, availabilityText: null };

/**
 * Factory (nie modul-level singleton) — `createApp`/testy volajú toto
 * PRESNE RAZ pri registrácii trás, takže cache je fresh per `createApp()`
 * inštanciu (rovnaký princíp, aký integration testy už používajú pre
 * KAŽDÝ ostatný stav v appke). Cache je kľúčovaná URL, VRÁTANE
 * neúspešných výsledkov (rovnaký princíp ako stará appka's diskový
 * `/api/images` cache, ktorý zapisoval aj prázdny výsledok pri zlyhaní) —
 * "cache responses ... so re-renders don't re-fetch" platí rovnako pre
 * "nič sa nenašlo" ako pre skutočný nález, inak by opakované otvorenie
 * panelu/re-render karty bez konca skúšalo ten istý zlyhávajúci fetch.
 */
export function createLiveSupplierInfoFetcher(client: SearchClient): (url: string) => Promise<SupplierDetailMeta> {
  const cache = new Map<string, SupplierDetailMeta>();

  return async (url: string): Promise<SupplierDetailMeta> => {
    const cached = cache.get(url);
    if (cached !== undefined) return cached;

    const adapter = adapterForUrl(url);
    if (adapter === undefined) {
      cache.set(url, EMPTY_META);
      return EMPTY_META;
    }

    try {
      const html = await client.fetchPage(url);
      const meta = adapter.extractDetailMeta(html);
      cache.set(url, meta);
      return meta;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn({ url, reason }, "pairing-review: živé info dodávateľa zlyhalo");
      cache.set(url, EMPTY_META);
      return EMPTY_META;
    }
  };
}
