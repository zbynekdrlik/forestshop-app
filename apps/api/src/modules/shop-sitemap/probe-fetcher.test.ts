import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShoptetBlockedError } from "../shoptet-http/blocked.js";
import { PROBE_THROTTLE_MS } from "./constants.js";
import { createHttpProbeFetcher } from "./probe-fetcher.js";

function stubFetch(impl: (url: string) => { ok: boolean; url: string }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const result = impl(String(input));
      return Promise.resolve({ ok: result.ok, url: result.url } as Response);
    }),
  );
}

describe("createHttpProbeFetcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("200 + finálna URL sa zhoduje s kandidátom → vráti finálnu URL", async () => {
    stubFetch((url) => ({ ok: true, url: url.replace("http://test/", "http://test/") }));
    const sleepCalls: number[] = [];
    const fetchCandidate = createHttpProbeFetcher({ baseUrl: "http://test/", sleep: (ms) => { sleepCalls.push(ms); return Promise.resolve(); } });
    const result = await fetchCandidate("bunda-forest");
    expect(result).toBe("http://test/bunda-forest/");
  });

  it("HTTP chyba (nie ok) → null, nikdy nevyhodí", async () => {
    stubFetch((url) => ({ ok: false, url }));
    const fetchCandidate = createHttpProbeFetcher({ baseUrl: "http://test/", sleep: () => Promise.resolve() });
    expect(await fetchCandidate("neexistuje")).toBeNull();
  });

  it("presmerovanie na /vyhladavanie fallback → null (nikdy nepovažuj vyhľadávanie za zhodu)", async () => {
    stubFetch(() => ({ ok: true, url: "http://test/vyhladavanie/?string=bunda" }));
    const fetchCandidate = createHttpProbeFetcher({ baseUrl: "http://test/", sleep: () => Promise.resolve() });
    expect(await fetchCandidate("bunda-forest")).toBeNull();
  });

  it("finálna URL sa NEZHODUJE s kandidátovým slugom (presmerované inam) → null", async () => {
    stubFetch(() => ({ ok: true, url: "http://test/uplne-iny-produkt/" }));
    const fetchCandidate = createHttpProbeFetcher({ baseUrl: "http://test/", sleep: () => Promise.resolve() });
    expect(await fetchCandidate("bunda-forest")).toBeNull();
  });

  it("throttle beží PO KAŽDOM pokuse (aj po neúspešnom) — finally vzor", async () => {
    stubFetch(() => ({ ok: false, url: "http://test/x" }));
    const sleepCalls: number[] = [];
    const fetchCandidate = createHttpProbeFetcher({
      baseUrl: "http://test/",
      throttleMs: 300,
      sleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
    });
    await fetchCandidate("a");
    await fetchCandidate("b");
    expect(sleepCalls).toEqual([300, 300]);
  });

  it("sieťová chyba (fetch vyhodí) → null, throttle sa aj tak spustí", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("network down"))),
    );
    const sleepCalls: number[] = [];
    const fetchCandidate = createHttpProbeFetcher({
      baseUrl: "http://test/",
      sleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
    });
    const result = await fetchCandidate("bunda-forest");
    expect(result).toBeNull();
    expect(sleepCalls).toEqual([PROBE_THROTTLE_MS]);
  });

  // issue 598: bloková stránka Shoptetu NESMIE splynúť s „kandidát neexistuje"
  // (null) — inak probe prechod pokračuje ďalšími stovkami požiadaviek do
  // zablokovaného e-shopu (PROD 21.–25. 10. 2026).
  it("bloková stránka Shoptetu (403 + „Access temporarily blocked“) → vyhodí ShoptetBlockedError, throttle sa aj tak spustí", async () => {
    const blockPage = readFileSync(new URL("../shoptet-http/fixtures/shoptet-block-page.html", import.meta.url), "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(blockPage, { status: 403 }))),
    );
    const sleepCalls: number[] = [];
    const fetchCandidate = createHttpProbeFetcher({
      baseUrl: "http://test/",
      sleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
    });
    await expect(fetchCandidate("bunda-forest")).rejects.toBeInstanceOf(ShoptetBlockedError);
    expect(sleepCalls).toEqual([PROBE_THROTTLE_MS]);
  });

  it("bežná 403 bez blokového textu → null (nie je to blok)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("Forbidden", { status: 403 }))),
    );
    const fetchCandidate = createHttpProbeFetcher({ baseUrl: "http://test/", sleep: () => Promise.resolve() });
    expect(await fetchCandidate("bunda-forest")).toBeNull();
  });
});
