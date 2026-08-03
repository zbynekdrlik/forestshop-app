// Stiahnutie stránky dodávateľa. Jediné miesto v module, ktoré sa dotýka
// siete — testy dodajú vlastnú implementáciu `PageFetcher` a NIKDY nechodia
// na skutočnú stránku dodávateľa (rovnaký vzor ako `catalog/fetcher.ts`'s
// `ExportFetcher` a `posta-uncollected`'s `tracking-client.ts`).

import { MAX_PAGE_BYTES, REQUEST_TIMEOUT_MS, USER_AGENT } from "./constants.js";

export interface PageFetchResult {
  /** `false` = kontrola sama zlyhala (sieť, časový limit, HTTP chyba). */
  readonly ok: boolean;
  readonly html: string;
  readonly httpStatus: number | null;
  readonly error: string | null;
}

export type PageFetcher = (url: string) => Promise<PageFetchResult>;

/**
 * Číta telo odpovede PO ČASTIACH a nad stropom spojenie preruší. `await
 * response.text()` by celé telo najprv zbufferoval bez ohľadu na strop —
 * strop by potom kontroloval až po vyčerpaní pamäte (presne to isté
 * zistenie ako `catalog/fetcher.ts`'s `readBounded`).
 */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = (body as ReadableStream).getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        text += decoder.decode(value, { stream: false });
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

/** Skutočné sťahovanie cez `fetch`. Nikdy nevyhodí — chybu vráti v `error`. */
export const fetchSupplierPage: PageFetcher = async (url: string): Promise<PageFetchResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    });
    if (!response.ok) {
      return { ok: false, html: "", httpStatus: response.status, error: `HTTP ${String(response.status)}` };
    }
    const html = await readBounded(response, MAX_PAGE_BYTES);
    return { ok: true, html, httpStatus: response.status, error: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, html: "", httpStatus: null, error: message.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
};
