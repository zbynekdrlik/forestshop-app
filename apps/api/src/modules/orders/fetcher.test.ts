import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeImportWindow,
  createHttpOrderIdsFetcher,
  createHttpOrdersExportFetcher,
  formatDateParam,
  redactSourceLabel,
  redactUrl,
} from "./fetcher.js";

/** Vytvorí `Response` so streamovaným telom o presne `sizeBytes` bajtoch. */
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
  it("prekryje prihlasovací hash, dateFrom/dateUntil nechá viditeľné (allowlist)", () => {
    expect(
      redactUrl(
        "https://www.forestshop.sk/export/orders.csv?patternId=-9&partnerId=3&hash=tajne123&dateFrom=2026-4-30&dateUntil=2026-7-29",
      ),
    ).toBe(
      "https://www.forestshop.sk/export/orders.csv?patternId=-9&partnerId=3&hash=***&dateFrom=2026-4-30&dateUntil=2026-7-29",
    );
  });

  it("prekryje AKÝKOĽVEK neznámy query parameter, nielen hash", () => {
    expect(redactUrl("https://e.sk/x.csv?token=zive-tajomstvo")).toBe("https://e.sk/x.csv?token=***");
  });
});

describe("redactSourceLabel", () => {
  it("nie-URL popisok (test/fixtúra) nechá nezmenený, nevyhodí výnimku", () => {
    expect(redactSourceLabel("fixtúra")).toBe("fixtúra");
  });
});

describe("formatDateParam", () => {
  it("formátuje bez nuly na začiatku mesiaca/dňa (Shoptet-ov tvar YYYY-M-D)", () => {
    expect(formatDateParam(new Date(Date.UTC(2026, 3, 30)))).toBe("2026-4-30");
    expect(formatDateParam(new Date(Date.UTC(2026, 6, 29)))).toBe("2026-7-29");
    // Jednociferný deň/mesiac sa NEPADDUJE — overené proti reálnemu exportu.
    expect(formatDateParam(new Date(Date.UTC(2026, 0, 5)))).toBe("2026-1-5");
  });
});

describe("computeImportWindow", () => {
  it("posledných 90 dní, počítané z 'now' — nikdy nehardcodované", () => {
    const now = new Date("2026-07-29T21:44:00Z");
    const { dateFrom, dateUntil } = computeImportWindow(now, 90);
    expect(dateUntil.toISOString()).toBe("2026-07-29T00:00:00.000Z");
    expect(dateFrom.toISOString()).toBe("2026-04-30T00:00:00.000Z");
  });

  it("window sa posúva s 'now' — o deň neskôr dá o deň posunuté okno", () => {
    const w1 = computeImportWindow(new Date("2026-07-29T00:00:00Z"), 90);
    const w2 = computeImportWindow(new Date("2026-07-30T00:00:00Z"), 90);
    expect(w2.dateUntil.getTime() - w1.dateUntil.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(w2.dateFrom.getTime() - w1.dateFrom.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("createHttpOrdersExportFetcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pridá dateFrom/dateUntil do stiahnutej URL v tvare YYYY-M-D", async () => {
    let requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        requestedUrl = url;
        return Promise.resolve(responseOfSize(10));
      }),
    );
    const fetcher = createHttpOrdersExportFetcher({
      url: "https://www.forestshop.sk/export/orders.csv?patternId=-9&partnerId=3&hash=tajne",
      dateFrom: new Date(Date.UTC(2026, 3, 30)),
      dateUntil: new Date(Date.UTC(2026, 6, 29)),
    });
    await fetcher();
    expect(requestedUrl).toContain("dateFrom=2026-4-30");
    expect(requestedUrl).toContain("dateUntil=2026-7-29");
  });

  it("sourceLabel je vždy prekrytý — hash sa nikde nedostane von", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseOfSize(10)));
    const fetcher = createHttpOrdersExportFetcher({
      url: "https://www.forestshop.sk/export/orders.csv?hash=tajne123",
      dateFrom: new Date(Date.UTC(2026, 3, 30)),
      dateUntil: new Date(Date.UTC(2026, 6, 29)),
    });
    const download = await fetcher();
    expect(download.sourceLabel).not.toContain("tajne123");
    expect(download.sourceLabel).toContain("hash=***");
  });

  it("odmietne (vyhodí), keď stiahnutý export prekročí strop veľkosti", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseOfSize(20_000)));
    const fetcher = createHttpOrdersExportFetcher({
      url: "https://e.sk/orders.csv",
      dateFrom: new Date(Date.UTC(2026, 3, 30)),
      dateUntil: new Date(Date.UTC(2026, 6, 29)),
      maxBytes: 10_000,
    });
    await expect(fetcher()).rejects.toThrow(/veľkosť/);
  });
});

// issue 120: druhý (XML) export — best-effort zdroj interného Shoptet id,
// nikdy nesmie ovplyvniť CSV strop/fetcher vyššie (samostatná funkcia,
// samostatný test súbor by bol zbytočný split — málo testov, rovnaká téma).
describe("createHttpOrderIdsFetcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pridá dateFrom/dateUntil rovnako ako CSV fetcher a vráti Map(kód → interné id)", async () => {
    let requestedUrl = "";
    const xml =
      "<ORDERS><ORDER><ORDER_ID>58656</ORDER_ID><CODE>20260897</CODE></ORDER></ORDERS>";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        requestedUrl = url;
        return Promise.resolve(new Response(xml, { status: 200 }));
      }),
    );
    const fetcher = createHttpOrderIdsFetcher({
      url: "https://www.forestshop.sk/export/orders.xml?patternId=-11&partnerId=3&hash=tajne",
      dateFrom: new Date(Date.UTC(2026, 3, 30)),
      dateUntil: new Date(Date.UTC(2026, 6, 29)),
    });
    const map = await fetcher();
    expect(requestedUrl).toContain("dateFrom=2026-4-30");
    expect(requestedUrl).toContain("dateUntil=2026-7-29");
    expect(map.get("20260897")).toBe(58656);
  });

  it("vyhodí, keď stiahnutie zlyhá s ne-200 stavom", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    const fetcher = createHttpOrderIdsFetcher({
      url: "https://e.sk/orders.xml",
      dateFrom: new Date(Date.UTC(2026, 3, 30)),
      dateUntil: new Date(Date.UTC(2026, 6, 29)),
    });
    await expect(fetcher()).rejects.toThrow(/zlyhalo/);
  });
});
