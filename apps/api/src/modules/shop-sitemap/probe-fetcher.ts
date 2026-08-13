// issue 402: HTTP sonda kandidátneho slugu — port `resolve_urls.py`'s
// `make_fetch()`: GET kandidátovu vlastnú stránku a potvrď, že sa
// nepresmerovala na `?string=` vyhľadávací fallback ani inam. Throttle PO
// KAŽDOM pokuse (rovnaký `finally`-vzor ako stará appka, aby throttle platil
// aj pri chybe), slušné správanie voči VLASTNÉMU e-shopu (rovnaká úvaha ako
// `pairing-search/client.ts`, len kratší interval — sondujeme vlastný
// server, nie tretiu stranu).

import { BASE_URL } from "./url-resolver.js";
import type { ProbeFetch } from "./candidates.js";
import { PROBE_THROTTLE_MS, REQUEST_TIMEOUT_MS } from "./constants.js";

export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface HttpProbeFetcherOptions {
  readonly baseUrl?: string;
  readonly throttleMs?: number;
  readonly timeoutMs?: number;
  readonly sleep?: Sleep;
}

/**
 * Reálny HTTP prober: GET `<baseUrl><candidateSlug>/`, potvrdí `200` A ŽE sa
 * finálna URL (po redirectoch) nepresmerovala na `/vyhladavanie` fallback a
 * KONČÍ presne na kandidátovom slugu (rovnaká dvojitá kontrola ako stará
 * appky `make_fetch`). Sieťová/timeout chyba sa NIKDY nešíri ďalej von —
 * jeden pokazený kandidát nesmie zhodiť celý probe prechod (rovnaký princíp
 * ako `pairing-search/adapters/url.ts`'s `resolveAndStripFragment`).
 */
export function createHttpProbeFetcher(options: HttpProbeFetcherOptions = {}): ProbeFetch {
  const baseUrl = options.baseUrl ?? BASE_URL;
  const throttleMs = options.throttleMs ?? PROBE_THROTTLE_MS;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;

  return async (candidateSlug: string): Promise<string | null> => {
    const url = baseUrl + candidateSlug + "/";
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!response.ok) return null;
      const finalUrl = response.url;
      if (finalUrl.includes("/vyhladavanie")) return null;
      const trimmed = finalUrl.replace(/\/+$/, "");
      if (!trimmed.endsWith("/" + candidateSlug) && !trimmed.endsWith(candidateSlug)) return null;
      return finalUrl;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      await sleep(throttleMs);
    }
  };
}
