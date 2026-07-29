import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpExportFetcher, redactSourceLabel, redactUrl } from "./fetcher.js";

/** Vytvorí `Response` so streamovaným telom o presne `sizeBytes` bajtoch, po `chunkSize`-och. */
function responseOfSize(sizeBytes: number, chunkSize = 1_000): Response {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= sizeBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, sizeBytes - sent);
      controller.enqueue(new Uint8Array(size).fill(65));
      sent += size;
    },
  });
  return new Response(stream, { status: 200 });
}

describe("redactUrl", () => {
  it("prekryje prihlasovací hash, neškodné parametre nechá (allowlist)", () => {
    expect(
      redactUrl("https://www.forestshop.sk/export/products.csv?patternId=14&partnerId=3&hash=tajne123"),
    ).toBe("https://www.forestshop.sk/export/products.csv?patternId=14&partnerId=3&hash=***");
  });

  it("prekryje hash bez ohľadu na veľkosť písmen v názve parametra", () => {
    expect(redactUrl("https://e.sk/x.csv?HASH=tajne")).toBe("https://e.sk/x.csv?HASH=***");
  });

  it("URL bez query stringu nechá nezmenenú", () => {
    expect(redactUrl("https://e.sk/x.csv")).toBe("https://e.sk/x.csv");
  });

  // Bránu treba obrátiť (review final-wave-a, položka 2): predtým sa prekrýval
  // LEN parameter menom presne "hash" a všetko ostatné sa vracalo nedotknuté.
  // Táto URL je dnes nakonfigurovaná so skutočným `hash`, takže nič dnes
  // neunikalo — ale rovnaký kód sa neskôr namieri na iný Shoptet export a ten
  // môže niesť prihlasovací údaj pod iným menom (napr. `token`). Prekrytá musí
  // byť hodnota KAŽDÉHO query parametra okrem malého allowlistu neškodných
  // (`patternId`, `partnerId`).
  it("prekryje AKÝKOĽVEK neznámy query parameter (napr. token), nielen hash", () => {
    expect(redactUrl("https://e.sk/x.csv?token=zive-tajomstvo")).toBe("https://e.sk/x.csv?token=***");
  });

  it("allowlistované parametre (patternId, partnerId) ostanú viditeľné aj bez hash/token vedľa nich", () => {
    expect(redactUrl("https://e.sk/x.csv?patternId=14&partnerId=3")).toBe(
      "https://e.sk/x.csv?patternId=14&partnerId=3",
    );
  });

  it("prekryje viacero neznámych parametrov naraz, allowlist nechá", () => {
    expect(redactUrl("https://e.sk/x.csv?patternId=14&token=abc&secret=xyz")).toBe(
      "https://e.sk/x.csv?patternId=14&token=***&secret=***",
    );
  });
});

// Minor (review task-5-fix-1): služba (ingest.ts) dôveruje `sourceLabel` od
// AKÉHOKOĽVEK vstreknutého fetchera — vlastnoručne napísaný fetcher (test,
// alebo budúci alternatívny zdroj) by mohol vrátiť surovú URL s `hash` priamo.
// `redactSourceLabel` je bezpečná obálka nad `redactUrl` pre volanie zo
// samotnej služby, nie len z `createHttpExportFetcher`.
describe("redactSourceLabel", () => {
  it("prekryje hash, keď je sourceLabel skutočná URL, ktorú fetcher neprekryl", () => {
    expect(redactSourceLabel("https://www.forestshop.sk/export/products.csv?hash=tajne123")).toBe(
      "https://www.forestshop.sk/export/products.csv?hash=***",
    );
  });

  it("nie-URL popisok (napr. z testu alebo budúceho iného zdroja) nechá nezmenený, nevyhodí výnimku", () => {
    expect(redactSourceLabel("fixtúra")).toBe("fixtúra");
  });

  it("už prekrytú URL (od createHttpExportFetcher) nechá nezmenenú — je idempotentná", () => {
    const already = redactUrl("https://e.sk/x.csv?hash=povodne");
    expect(redactSourceLabel(already)).toBe(already);
  });
});

// Important (review final-wave-a, položka 7): fetcher predtým bufferoval
// celú odpoveď (`Buffer.from(await response.arrayBuffer())`) bez akéhokoľvek
// stropu — pokazený alebo nepriateľský server, ktorý pošle oveľa viac než
// reálny 57 MB export, by mohol vyčerpať pamäť kontajnera. Strop musí byť
// dosť veľkorysý pre reálny export, ale prekročenie sa má preložiť na
// bežné ODMIETNUTIE (chybu, ktorú `ingestCatalog`/HTTP vrstva vie zachytiť
// a zapísať — review final-wave-a, položka 4), nikdy na pád procesu.
describe("createHttpExportFetcher — strop veľkosti", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stiahne export pod stropom bez problémov", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseOfSize(5_000)));
    const fetcher = createHttpExportFetcher({ url: "https://e.sk/x.csv", maxBytes: 10_000 });
    const download = await fetcher();
    expect(download.body.byteLength).toBe(5_000);
  });

  it("odmietne (vyhodí), keď stiahnutý export prekročí strop — nikdy nepokračuje v bufferovaní donekonečna", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseOfSize(20_000)));
    const fetcher = createHttpExportFetcher({ url: "https://e.sk/x.csv", maxBytes: 10_000 });
    await expect(fetcher()).rejects.toThrow(/veľkosť/);
  });

  it("export presne na hranici stropu prejde (hranica je vrátane)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseOfSize(10_000)));
    const fetcher = createHttpExportFetcher({ url: "https://e.sk/x.csv", maxBytes: 10_000 });
    const download = await fetcher();
    expect(download.body.byteLength).toBe(10_000);
  });
});
