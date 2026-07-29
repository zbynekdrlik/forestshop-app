import type { ExportDownload, ExportFetcher } from "./ingest.js";

/**
 * Query parametre, o ktorých je isté, že nenesú prihlasovací údaj — zámerne
 * krátky zoznam (review final-wave-a, položka 2). Predtým sa prekrýval LEN
 * parameter menom presne `hash` (allowlist naopak — jeden zakázaný, všetko
 * ostatné prešlo). Dnešná produkčná URL má prihlasovací údaj skutočne pod
 * `hash`, takže dnes nič neuniká — ale tento istý kód sa v ďalších fázach
 * namieri na ĎALŠIE Shoptet exporty, a jeden z nich môže niesť prihlasovací
 * údaj pod iným menom parametra. Preto sa prekrýva VŠETKO okrem tohto
 * allowlistu, nie naopak.
 */
const HARMLESS_QUERY_PARAMS: ReadonlySet<string> = new Set(["patternid", "partnerid"]);

/**
 * URL môže niesť prihlasovací údaj v ľubovoľnom query parametri (Shoptet ho dnes
 * volá `hash`, iný export ho môže volať inak). Do databázy ani do logov sa nikdy
 * nesmie dostať celá URL — `sourceLabel` je vždy takto prekrytá verzia. Origin aj
 * path zostávajú viditeľné (nenesú tajomstvo, sú užitočné na identifikáciu zdroja).
 */
export function redactUrl(url: string): string {
  const parsed = new URL(url);
  for (const key of [...parsed.searchParams.keys()]) {
    if (!HARMLESS_QUERY_PARAMS.has(key.toLowerCase())) parsed.searchParams.set(key, "***");
  }
  return parsed.toString();
}

/**
 * Bezpečná obálka nad `redactUrl` pre volanie zo SLUŽBY (`ingest.ts`), nie len
 * z `createHttpExportFetcher` — `ExportFetcher` je vstrekované rozhranie, takže
 * ingest dôveruje `sourceLabel` od AKÉHOKOĽVEK dodaného fetchera (test, alebo
 * budúci ručne písaný zdroj). Keď `label` nie je platná URL (napr. testovací
 * popisok "fixtúra"), `redactUrl` by vyhodil — tu sa taký prípad ticho vráti
 * nezmenený, keďže nejde o URL, ktorá by mohla niesť `hash`.
 */
export function redactSourceLabel(label: string): string {
  try {
    return redactUrl(label);
  } catch {
    return label;
  }
}

export interface HttpExportFetcherOptions {
  readonly url: string;
  readonly timeoutMs?: number;
}

export function createHttpExportFetcher(options: HttpExportFetcherOptions): ExportFetcher {
  return async (): Promise<ExportDownload> => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, options.timeoutMs ?? 180_000);
    try {
      const response = await fetch(options.url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Stiahnutie exportu zlyhalo so stavom ${String(response.status)}`);
      }
      return {
        body: Buffer.from(await response.arrayBuffer()),
        sourceLabel: redactUrl(options.url),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
