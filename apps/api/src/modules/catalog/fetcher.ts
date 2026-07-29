import type { ExportDownload, ExportFetcher } from "./ingest.js";

/**
 * Prihlasovací údaj Shoptetu je `hash` v query parametri URL. Do databázy ani do
 * logov sa nikdy nesmie dostať celá URL — `sourceLabel` je vždy takto prekrytá verzia.
 */
export function redactUrl(url: string): string {
  const parsed = new URL(url);
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase() === "hash") parsed.searchParams.set(key, "***");
  }
  return parsed.toString();
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
