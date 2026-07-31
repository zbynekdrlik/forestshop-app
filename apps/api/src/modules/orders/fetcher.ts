import type { OrdersExportDownload, OrdersExportFetcher } from "./ingest.js";
import { extractOrderIdsFromXml } from "./parser.js";

/**
 * Rovnaký vzor ako `catalog/fetcher.ts`'s allowlist — prekrýva sa HODNOTA
 * KAŽDÉHO query parametra okrem tohto malého zoznamu známych neškodných.
 * `dateFrom`/`dateUntil` sú tu naviac oproti katalógu (#21): sú to obyčajné
 * dátumy, nie prihlasovací údaj, takže musia zostať čitateľné v logoch — inak
 * by prekrytie skrylo presne to okno, ktoré operátor potrebuje vidieť pri
 * ladení "prečo import vrátil len X objednávok".
 */
const HARMLESS_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "patternid",
  "partnerid",
  "datefrom",
  "dateuntil",
]);

/**
 * URL môže niesť prihlasovací údaj v ľubovoľnom query parametri (Shoptet ho dnes
 * volá `hash`). Do databázy ani do logov sa nikdy nesmie dostať celá URL —
 * `sourceLabel` je vždy takto prekrytá verzia.
 */
export function redactUrl(url: string): string {
  const parsed = new URL(url);
  for (const key of [...parsed.searchParams.keys()]) {
    if (!HARMLESS_QUERY_PARAMS.has(key.toLowerCase())) parsed.searchParams.set(key, "***");
  }
  return parsed.toString();
}

/** Bezpečná obálka nad `redactUrl` pre volanie zo služby (`ingest.ts`) — rovnaký
 *  dôvod ako `catalog/fetcher.ts`'s `redactSourceLabel`. */
export function redactSourceLabel(label: string): string {
  try {
    return redactUrl(label);
  } catch {
    return label;
  }
}

// 90-dňový export má ~1.1 MB (525 objednávok); strop je zámerne rovnako
// veľkorysý ako katalóg (kde reálny export má ~57 MB) — konečný, ale ďaleko
// nad čímkoľvek, čo by 90 dní objednávok mohlo legitímne vyprodukovať.
export const DEFAULT_MAX_ORDERS_EXPORT_BYTES = 200 * 1024 * 1024;

/**
 * Shoptet's `dateFrom`/`dateUntil` čakajú `YYYY-M-D` — BEZ nuly na začiatku
 * mesiaca/dňa (overené `curl` proti reálnemu exportu, 2026-07-29: zero-padded
 * tvar nebol testovaný a nie je to, čo produkcia posiela). `Date`'s UTC gettery
 * (nie lokálne), aby formátovanie nezáviselo od časovej zóny hostiteľa.
 */
export function formatDateParam(date: Date): string {
  return `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1)}-${String(date.getUTCDate())}`;
}

/**
 * Posledných `windowDays` dní ako kalendárne UTC dni — okno sa POSÚVA každým
 * behom (dnešný import má iné `dateFrom`/`dateUntil` než včerajší), preto sa
 * vždy počíta z `now`, nikdy sa nehardcoduje (#21 zadanie). `now` je vždy
 * explicitný vstup (rovnaká disciplína ako `ingestCatalog`'s `now`), nikdy sa
 * nečíta z globálnych hodín tu.
 */
export function computeImportWindow(
  now: Date,
  windowDays = 90,
): { readonly dateFrom: Date; readonly dateUntil: Date } {
  const dateUntil = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dateFrom = new Date(dateUntil.getTime() - windowDays * 24 * 60 * 60 * 1000);
  return { dateFrom, dateUntil };
}

function withDateWindow(url: string, dateFrom: Date, dateUntil: Date): string {
  const parsed = new URL(url);
  parsed.searchParams.set("dateFrom", formatDateParam(dateFrom));
  parsed.searchParams.set("dateUntil", formatDateParam(dateUntil));
  return parsed.toString();
}

/**
 * Rovnaká implementácia ako `catalog/fetcher.ts`'s `readBounded` — číta telo
 * odpovede PO ČASTIACH a priebežne sčitáva veľkosť, nikdy
 * `Buffer.from(await response.arrayBuffer())` (to by celé telo najprv
 * zbufferovalo bez ohľadu na strop).
 */
async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) {
    return Buffer.from(await response.arrayBuffer());
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(
        `Stiahnutý export objednávok prekročil povolenú veľkosť ${String(maxBytes)} bajtov — stiahnutie bolo zastavené.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export interface HttpOrdersExportFetcherOptions {
  readonly url: string;
  readonly dateFrom: Date;
  readonly dateUntil: Date;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export function createHttpOrdersExportFetcher(
  options: HttpOrdersExportFetcherOptions,
): OrdersExportFetcher {
  const url = withDateWindow(options.url, options.dateFrom, options.dateUntil);
  return async (): Promise<OrdersExportDownload> => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, options.timeoutMs ?? 180_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Stiahnutie exportu objednávok zlyhalo so stavom ${String(response.status)}`);
      }
      return {
        body: await readBounded(response, options.maxBytes ?? DEFAULT_MAX_ORDERS_EXPORT_BYTES),
        sourceLabel: redactUrl(url),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

// issue 120: druhý, SAMOSTATNÝ export (XML, `patternId=-11`) — jediný zdroj
// interného Shoptet id objednávky (CSV vyššie ho nenesie vôbec, viď
// `parser.ts`'s `extractOrderIdsFromXml`). Nefiltrovaná plná história má
// ~74 MB (naživo overené, 2026-07-31), preto strop necháva rovnaký
// veľkorysý priestor ako CSV — windowovaný (rovnaké `dateFrom`/`dateUntil`
// ako hlavný CSV import) beh má v praxi len pár MB.
export const DEFAULT_MAX_ORDER_IDS_XML_BYTES = 200 * 1024 * 1024;

export type OrderIdsFetcher = () => Promise<ReadonlyMap<string, number>>;

export interface HttpOrderIdsFetcherOptions {
  readonly url: string;
  readonly dateFrom: Date;
  readonly dateUntil: Date;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/**
 * Best-effort obohatenie — volajúci (`ingest.ts`) NESMIE nechať zlyhanie
 * tohto fetchu spadnúť celý import objednávok (interné id je len vylepšenie
 * odkazu do administrácie, nikdy podmienka prijatia dát).
 */
export function createHttpOrderIdsFetcher(options: HttpOrderIdsFetcherOptions): OrderIdsFetcher {
  const url = withDateWindow(options.url, options.dateFrom, options.dateUntil);
  return async (): Promise<ReadonlyMap<string, number>> => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, options.timeoutMs ?? 180_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Stiahnutie interných Shoptet id objednávok zlyhalo so stavom ${String(response.status)}`);
      }
      const body = await readBounded(response, options.maxBytes ?? DEFAULT_MAX_ORDER_IDS_XML_BYTES);
      return extractOrderIdsFromXml(body.toString("utf-8"));
    } finally {
      clearTimeout(timer);
    }
  };
}
