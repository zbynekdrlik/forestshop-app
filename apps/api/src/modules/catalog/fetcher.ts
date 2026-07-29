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

// Reálny export má ~57 MB. Strop je zámerne veľkorysý voči tomu (takmer
// štvornásobok), aby normálny rast katalógu naň nenarazil, ale konečný —
// pokazený alebo nepriateľský server, ktorý by inak posielal dáta donekonečna,
// nesmie vyčerpať pamäť kontajnera (review final-wave-a, položka 7).
export const DEFAULT_MAX_EXPORT_BYTES = 200 * 1024 * 1024;

export interface HttpExportFetcherOptions {
  readonly url: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/**
 * Číta telo odpovede PO ČASTIACH a priebežne sčitáva veľkosť — `Buffer.from(await
 * response.arrayBuffer())` by celé telo najprv bufferovalo bez ohľadu na strop,
 * takže strop kontroluje až PO tom, čo pamäť už bola vyčerpaná. Táto funkcia
 * zruší čítanie (`reader.cancel()`) HNEĎ, ako súčet prekročí strop, a vyhodí
 * bežnú chybu — nikdy nenechá proces spadnúť na pamäť.
 */
async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  // `Response.body` je (bez `dom` libu, len `@types/node`'s `undici-types`)
  // typovaný ako `ReadableStream` bez generika, teda efektívne
  // `ReadableStream<any>` — cast na `Uint8Array` je bezpečný, `fetch` telo
  // odpovede vždy strieamuje bajty, nikdy nič iné.
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
        `Stiahnutý export prekročil povolenú veľkosť ${String(maxBytes)} bajtov — stiahnutie bolo zastavené.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
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
        body: await readBounded(response, options.maxBytes ?? DEFAULT_MAX_EXPORT_BYTES),
        sourceLabel: redactUrl(options.url),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
