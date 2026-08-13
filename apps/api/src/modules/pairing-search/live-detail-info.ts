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

// issue 422 review nález (🟡): appka beží ako dlhoživý kontajner (dni, nie
// jeden request) — cache BEZ TTL by "živé" info navždy zamrazila na prvej
// hodnote (aj prvom ZLYHANÍ), čo je presný opak toho, čo "živé" sľubuje.
// 15 minút je kompromis: dosť dlho, aby prehliadanie/re-render toho istého
// produktu počas JEDNEJ review relácie nikdy neopakovalo fetch (design
// zámer, "re-renders don't re-fetch"), dosť krátko, aby sa cena/dostupnosť
// naozaj obnovila naprieč dlhším behom appky.
const CACHE_TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  readonly meta: SupplierDetailMeta;
  readonly cachedAt: number;
}

export interface LiveSupplierInfoFetcherOptions {
  /** Injektovateľné pre testy — nikdy skutočné `Date.now`. */
  readonly now?: () => number;
}

/**
 * Factory (nie modul-level singleton) — `createApp`/testy volajú toto
 * PRESNE RAZ pri registrácii trás, takže cache je fresh per `createApp()`
 * inštanciu (rovnaký princíp, aký integration testy už používajú pre
 * KAŽDÝ ostatný stav v appke). Cache je kľúčovaná URL, VRÁTANE
 * neúspešných výsledkov (rovnaký princíp ako stará appka's diskový
 * `/api/images` cache, ktorý zapisoval aj prázdny výsledok pri zlyhaní) —
 * "cache responses ... so re-renders don't re-fetch" platí rovnako pre
 * "nič sa nenašlo" ako pre skutočný nález — ale s TTL (`CACHE_TTL_MS`
 * vyššie), nikdy navždy (review nález #422).
 *
 * URL MIMO troch známych adaptérov (`adapterForUrl` vráti `undefined`) sa
 * cachuje BEZ TTL — to je štrukturálny fakt o URL (jej host jednoducho
 * nepatrí žiadnemu adaptérovi), nikdy sa nezmení, takže re-check po TTL by
 * bol čistá réžia bez šance na iný výsledok.
 */
export function createLiveSupplierInfoFetcher(client: SearchClient, options: LiveSupplierInfoFetcherOptions = {}): (url: string) => Promise<SupplierDetailMeta> {
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const unknownHostUrls = new Set<string>();

  return async (url: string): Promise<SupplierDetailMeta> => {
    if (unknownHostUrls.has(url)) return EMPTY_META;

    const cached = cache.get(url);
    if (cached !== undefined && now() - cached.cachedAt < CACHE_TTL_MS) return cached.meta;

    const adapter = adapterForUrl(url);
    if (adapter === undefined) {
      unknownHostUrls.add(url);
      return EMPTY_META;
    }

    try {
      const html = await client.fetchPage(url);
      const meta = adapter.extractDetailMeta(html);
      cache.set(url, { meta, cachedAt: now() });
      return meta;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn({ url, reason }, "pairing-review: živé info dodávateľa zlyhalo");
      cache.set(url, { meta: EMPTY_META, cachedAt: now() });
      return EMPTY_META;
    }
  };
}
