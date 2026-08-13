// HTTP vyhľadávací klient (issue 387 E2) — doslovný port `src/parovanie/
// client.py`'s `SearchClient`+`_SessionFetcher` dvojice zo starej appky
// (commit 60b6164). Hranica siete je celá izolovaná v `nodeFetch` (jediné
// miesto, ktoré sa dotýka skutočného `fetch`, rovnaký vzor ako `supplier-
// stock/page-fetcher.ts`'s `PageFetcher`) — testy dodajú vlastný `Fetcher`
// a NIKDY nechodia na skutočný dodávateľský web.
//
// Chovanie (návrh, sekcia „SearchClient's chovanie", overené naživo
// 13. 8. 2026 proti wetland.sk/huntingshop.eu/odimon.sk):
// - **Homepage warm-up RAZ per host** — huntingshop.eu (Nette) aj
//   odimon.sk (BUXUS) vrátia PRÁZDNE výsledky bez platnej session cookie;
//   `_warm` v starej appke skúsi warm-up presne raz a host označí za
//   "warmed" AJ pri zlyhaní (žiadny opakovaný pokus pri ďalšom dopyte na
//   ten istý host) — port zachováva toto správanie doslovne.
// - **Throttle 0,7 s** raz pred KAŽDÝM `SearchClient.search()` volaním,
//   ktoré skutočne ide na sieť (nie pri cache hite, nikdy pri
//   injektovanom fake fetcheri v testoch — identity-check proti
//   `nativeFetcher`, port Pythonovho `fetch is _DEFAULT_FETCH`).
// - **3 pokusy s backoffom 1,5·(pokus+1) s** — doslovný port vrátane toho,
//   že sa čaká AJ po poslednom neúspešnom pokuse pred vyhodením chyby
//   (Pythonov `for attempt in range(MAX_RETRIES): ... time.sleep(...)`
//   beží ešte raz po poslednom zlyhaní, potom až `raise`).
// - **Timeout 25 s** na KAŽDÝ jednotlivý pokus (`AbortController`,
//   rovnaký vzor ako `page-fetcher.ts`'s `readBounded`/timer).
// - **In-memory cache** kľúčovaná (adapterKey, query) — voliteľne
//   zdieľateľná naprieč viacerými `SearchClient` inštanciami (rovnaký
//   zámer ako Pythonov `cache: dict | None` konštruktorový parameter).

import { log } from "../../logger.js";
import type { PairingCandidate } from "./types.js";
import { adapterFor } from "./adapters/registry.js";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const THROTTLE_MS = 700;
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_RETRIES = 3;

/** Minimálne rozhranie skutočnej HTTP odpovede, ktoré `client.ts` potrebuje
 *  — vlastné, nie priamo DOM `Response`, aby testy vedeli podhodiť triviálny
 *  fake objekt (rovnaký zámer ako `page-fetcher.ts`'s `PageFetchResult`). */
export interface RawResponse {
  readonly status: number;
  /** `Headers.getSetCookie()` — VŠETKY `Set-Cookie` hlavičky oddelene
   *  (undici/Node 24 ju podporuje); nikdy `headers.get("set-cookie")`,
   *  ktorý by viacero hlavičiek zlúčil čiarkou a rozbil hodnoty s vlastnou
   *  čiarkou (napr. `Expires=Wed, 09 Jun ...`). */
  getSetCookie(): readonly string[];
  text(): Promise<string>;
}

export type RawFetcher = (url: string, init: { headers: Record<string, string> }) => Promise<RawResponse>;

/** Skutočné sťahovanie cez natívny `fetch`. Nikdy nevolaná priamo testami. */
export const nodeFetch: RawFetcher = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: init.headers, redirect: "follow", signal: controller.signal });
    return {
      status: response.status,
      getSetCookie: () => response.headers.getSetCookie(),
      text: () => response.text(),
    };
  } finally {
    clearTimeout(timer);
  }
};

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Port Pythonovho `urlsplit(url).netloc` — host (+port, ak je) danej URL. */
function hostOf(url: string): string {
  return new URL(url).host;
}

/** Prvý `meno=hodnota` pár zo `Set-Cookie` hlavičky (zvyšok — `Path=`,
 *  `Expires=`, `HttpOnly`, ... — appka nepotrebuje, len ho posiela ďalej
 *  naspäť dodávateľovi cez `Cookie:` hlavičku). */
function parseSetCookiePair(header: string): readonly [string, string] | null {
  const body = header.split(";", 1)[0] ?? "";
  const eq = body.indexOf("=");
  if (eq === -1) return null;
  const name = body.slice(0, eq).trim();
  const value = body.slice(eq + 1).trim();
  return name ? [name, value] : null;
}

function baseHeaders(cookie: string): Record<string, string> {
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" };
  if (cookie) headers["cookie"] = cookie;
  return headers;
}

/** Port `_SessionFetcher.__call__`'s retry slučky: 3 pokusy, 2xx inak
 *  chyba, backoff 1,5·(pokus+1) s medzi pokusmi (aj po poslednom).
 *
 *  `buildHeaders` sa volá NANOVO PRED KAŽDÝM pokusom (nie raz vopred) —
 *  `onResponseCookies` (nižšie) sa volá pre KAŽDÚ prijatú odpoveď (aj
 *  ne-2xx), takže cookie vydaná spolu s napr. 503 na 1. pokuse MUSÍ byť
 *  súčasťou hlavičiek 2. pokusu (review nález, issue 387 E2 — jeden
 *  vopred zmrazený `headers` objekt by ju stratil, presnú regresiu na to
 *  drží `client.test.ts`'s "captures a Set-Cookie carried on a FAILED
 *  (non-2xx) attempt" test). Port `requests.Session`'s správania, ktoré
 *  cookies extrahuje zo VŠETKÝCH odpovedí, nielen z tej poslednej
 *  úspešnej. */
async function fetchWithRetry(
  rawFetch: RawFetcher,
  url: string,
  buildHeaders: () => Record<string, string>,
  sleep: (ms: number) => Promise<void>,
  onResponseCookies: (setCookie: readonly string[]) => void,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const response = await rawFetch(url, { headers: buildHeaders() });
      onResponseCookies(response.getSetCookie());
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${String(response.status)}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      const reason = error instanceof Error ? error.message : String(error);
      log.warn({ url, attempt: attempt + 1, reason }, "pairing-search: fetch zlyhal, skúšam znova");
      await sleep(1.5 * (attempt + 1) * 1000);
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  log.error({ url, attempts: MAX_RETRIES, reason }, "pairing-search: fetch zlyhal aj po opakovaných pokusoch");
  throw new Error(`fetch zlyhal aj po opakovaných pokusoch: ${url} (${reason})`);
}

/** Funkcia, ktorá pre danú URL vráti telo HTML odpovede — `SearchClient`
 *  vidí LEN toto, nikdy priamo `RawFetcher`/cookies/retry (tie žijú vo
 *  vnútri `createSessionFetcher`, presne ako Pythonov `_SessionFetcher`
 *  bol jediná implementácia `Callable[[str], str]` typu, ktorý `SearchClient`
 *  poznal). Testy injektujú vlastný `Fetcher`, ktorý celú túto vrstvu
 *  obchádza. */
export type Fetcher = (url: string) => Promise<string>;

export interface SessionFetcherOptions {
  readonly rawFetch?: RawFetcher;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Stavový fetcher s per-host cookie jar + homepage warm-up + retry — port
 * `client.py`'s `_SessionFetcher`. Každé volanie vrátenej funkcie warm-uje
 * svoj host (raz), pošle uložené cookies, a pri zlyhaní opakuje.
 */
export function createSessionFetcher(options: SessionFetcherOptions = {}): Fetcher {
  const rawFetch = options.rawFetch ?? nodeFetch;
  const sleep = options.sleep ?? realSleep;
  const cookieJar = new Map<string, Map<string, string>>();
  const warmedHosts = new Set<string>();

  function cookieHeaderFor(host: string): string {
    const jar = cookieJar.get(host);
    if (!jar || jar.size === 0) return "";
    return Array.from(jar.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  function storeSetCookies(host: string, setCookie: readonly string[]): void {
    if (setCookie.length === 0) return;
    const jar = cookieJar.get(host) ?? new Map<string, string>();
    for (const header of setCookie) {
      const pair = parseSetCookiePair(header);
      if (pair) jar.set(pair[0], pair[1]);
    }
    cookieJar.set(host, jar);
  }

  async function warmHost(host: string): Promise<void> {
    if (warmedHosts.has(host)) return;
    try {
      const response = await rawFetch(`https://${host}/`, { headers: baseHeaders(cookieHeaderFor(host)) });
      storeSetCookies(host, response.getSetCookie());
      log.info({ host }, "pairing-search: zohriata session (homepage warm-up)");
    } catch (error) {
      // Port `_warm`'s `except Exception: log.warning(...)` — zlyhaný
      // warm-up sa neopakuje, host sa napriek tomu označí za "warmed"
      // (nižšie, mimo try/catch, presne ako v Pythone).
      const reason = error instanceof Error ? error.message : String(error);
      log.warn({ host, reason }, "pairing-search: warm-up zlyhal, host sa aj tak označí za zohriaty");
    }
    warmedHosts.add(host);
  }

  return async (url: string): Promise<string> => {
    const host = hostOf(url);
    await warmHost(host);
    return fetchWithRetry(
      rawFetch,
      url,
      () => baseHeaders(cookieHeaderFor(host)),
      sleep,
      (setCookie) => {
        storeSetCookies(host, setCookie);
      },
    );
  };
}

/** Jediná zdieľaná "reálna" inštancia — identity-check proti nej rozhoduje,
 *  či `SearchClient` throttluje (port Pythonovho `fetch is _DEFAULT_FETCH`). */
export const nativeFetcher: Fetcher = createSessionFetcher();

export interface SearchClientOptions {
  readonly fetcher?: Fetcher;
  readonly cache?: Map<string, readonly PairingCandidate[]>;
  readonly throttleMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** HTTP vyhľadávací klient — port `client.py`'s `SearchClient`. */
export class SearchClient {
  private readonly fetcher: Fetcher;
  private readonly cache: Map<string, readonly PairingCandidate[]>;
  private readonly throttleMs: number;
  private readonly isReal: boolean;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: SearchClientOptions = {}) {
    this.fetcher = options.fetcher ?? nativeFetcher;
    this.cache = options.cache ?? new Map<string, readonly PairingCandidate[]>();
    this.throttleMs = options.throttleMs ?? THROTTLE_MS;
    this.isReal = this.fetcher === nativeFetcher;
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * Vyhľadá `query` u dodávateľa `adapterKey` (`registry.ts`) a vráti
   * spárovaných kandidátov — cachovaných podľa (adapterKey, query).
   */
  async search(adapterKey: string, query: string): Promise<readonly PairingCandidate[]> {
    const adapter = adapterFor(adapterKey);
    if (!adapter) {
      throw new Error(`neznámy pairing-search adaptér: ${adapterKey}`);
    }

    const cacheKey = `${adapterKey} ${query}`;
    const cached = this.cache.get(cacheKey);
    // `.has()` (nie truthy-check na `cached`) — 0 nájdených kandidátov je
    // platný, cachovateľný výsledok (port Pythonovho `if key in self._cache`).
    if (this.cache.has(cacheKey)) return cached ?? [];

    if (this.isReal && this.throttleMs > 0) {
      await this.sleep(this.throttleMs);
    }

    const url = adapter.buildSearchUrl(query);
    const html = await this.fetcher(url);
    const candidates = adapter.parseSearchResults(html);
    log.info({ adapterKey, query, count: candidates.length }, "pairing-search: vyhľadávanie dokončené");
    this.cache.set(cacheKey, candidates);
    return candidates;
  }

  /**
   * Stiahne DETAILNÚ stránku kandidáta (issue 387 E4's `verify.ts`) — ROVNAKÝ
   * throttle-if-real ako `.search()`, ale BEZ cache (detailná URL je vždy
   * jedinečná, na rozdiel od (adapterKey, query) párov). Zdieľa TEN ISTÝ
   * `this.fetcher` (session cookie jar + retry + warm-up z `.search()`
   * volaní v tom istom gather cykle), takže detail-page fetch profituje z
   * už zohriatej relácie na daný host namiesto opätovného warm-upu.
   */
  async fetchPage(url: string): Promise<string> {
    if (this.isReal && this.throttleMs > 0) {
      await this.sleep(this.throttleMs);
    }
    return this.fetcher(url);
  }
}
