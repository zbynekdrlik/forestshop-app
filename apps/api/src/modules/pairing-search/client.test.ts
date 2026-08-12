import { afterEach, describe, expect, it, vi } from "vitest";
import type { PairingCandidate } from "./types.js";
import {
  createSessionFetcher,
  nativeFetcher,
  SearchClient,
  type Fetcher,
  type RawFetcher,
  type RawResponse,
} from "./client.js";

function fakeResponse(text: string, options: { status?: number; setCookie?: readonly string[] } = {}): RawResponse {
  return {
    status: options.status ?? 200,
    getSetCookie: () => options.setCookie ?? [],
    text: () => Promise.resolve(text),
  };
}

describe("SearchClient", () => {
  it("delegates to the injected Fetcher and parses via the resolved adapter", async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = (url) => {
      calls.push(url);
      return Promise.resolve('<div class="product-list__results"></div>');
    };
    const client = new SearchClient({ fetcher });

    const candidates = await client.search("odimon", "nohavice");

    expect(candidates).toEqual([]);
    expect(calls).toEqual(["https://www.odimon.sk/vysledky-vyhladavania?term=nohavice"]);
  });

  it("caches by (adapterKey, query) — a second identical search never calls the fetcher again", async () => {
    let callCount = 0;
    const fetcher: Fetcher = () => {
      callCount += 1;
      return Promise.resolve('<div class="product-list__results"></div>');
    };
    const client = new SearchClient({ fetcher });

    await client.search("odimon", "rovnaky dopyt");
    await client.search("odimon", "rovnaky dopyt");

    expect(callCount).toBe(1);
  });

  it("a different query for the same supplier is NOT a cache hit", async () => {
    let callCount = 0;
    const fetcher: Fetcher = () => {
      callCount += 1;
      return Promise.resolve('<div class="product-list__results"></div>');
    };
    const client = new SearchClient({ fetcher });

    await client.search("odimon", "prva");
    await client.search("odimon", "druha");

    expect(callCount).toBe(2);
  });

  it("throws for an unknown adapterKey", async () => {
    const client = new SearchClient({ fetcher: () => Promise.resolve("") });
    await expect(client.search("neexistujuci", "x")).rejects.toThrow(/neznámy pairing-search adaptér/);
  });

  it("never throttles for an injected (non-native) fetcher", async () => {
    const sleepCalls: number[] = [];
    const fetcher: Fetcher = () => Promise.resolve('<div class="product-list__results"></div>');
    const client = new SearchClient({
      fetcher,
      sleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
    });

    await client.search("odimon", "test");

    expect(sleepCalls).toEqual([]);
  });

  it("returns candidates with rawScore/codeHit=0/false and code/price=null (ranking.ts fills these in later)", async () => {
    const fetcher: Fetcher = () =>
      Promise.resolve(
        '<div class="product-list__results"><a class="product-card" href="https://www.odimon.sk/p"><img alt="Test produkt"></a></div>',
      );
    const client = new SearchClient({ fetcher });

    const candidates = await client.search("odimon", "test");

    expect(candidates).toEqual<readonly PairingCandidate[]>([
      { name: "Test produkt", url: "https://www.odimon.sk/p", code: null, price: null, rawScore: 0, codeHit: false },
    ]);
  });
});

describe("SearchClient real-fetcher throttle path (nativeFetcher identity)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throttles 700ms before the request when the fetcher IS nativeFetcher — never for a custom one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response('<div class="product-list__results"></div>', { status: 200 }))),
    );
    const sleepCalls: number[] = [];
    // fetcher omitted => defaults to nativeFetcher => isReal === true.
    const client = new SearchClient({
      sleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
    });

    await client.search("odimon", "nazivo-stubovana-siet-throttle-test");

    expect(sleepCalls).toEqual([700]);
  });
});

describe("createSessionFetcher", () => {
  it("warms the host once (homepage GET) before the first request to that host", async () => {
    const requestedUrls: string[] = [];
    const rawFetch: RawFetcher = (url) => {
      requestedUrls.push(url);
      return Promise.resolve(fakeResponse("<html></html>"));
    };
    const fetcher = createSessionFetcher({ rawFetch, sleep: () => Promise.resolve() });

    await fetcher("https://example.sk/search?q=a");
    await fetcher("https://example.sk/search?q=b");

    // Warm-up (homepage) happens exactly once, before the first real request;
    // second call to the SAME host must not warm up again.
    expect(requestedUrls).toEqual([
      "https://example.sk/",
      "https://example.sk/search?q=a",
      "https://example.sk/search?q=b",
    ]);
  });

  it("still marks the host as warmed even when the warm-up request itself fails", async () => {
    let warmupAttempts = 0;
    const rawFetch: RawFetcher = (url) => {
      if (url === "https://example.sk/") {
        warmupAttempts += 1;
        return Promise.reject(new Error("warm-up network error"));
      }
      return Promise.resolve(fakeResponse("<html></html>"));
    };
    const fetcher = createSessionFetcher({ rawFetch, sleep: () => Promise.resolve() });

    await fetcher("https://example.sk/search?q=a");
    await fetcher("https://example.sk/search?q=b");

    // Port `_warm`'s Python behaviour: failed warm-up is attempted exactly
    // once per host, never retried on a later request to the same host.
    expect(warmupAttempts).toBe(1);
  });

  it("propagates a Set-Cookie from warm-up into the Cookie header of the following request", async () => {
    const seenCookieHeaders: (string | undefined)[] = [];
    const rawFetch: RawFetcher = (url, init) => {
      seenCookieHeaders.push(init.headers["cookie"]);
      if (url === "https://example.sk/") {
        return Promise.resolve(fakeResponse("<html></html>", { setCookie: ["PHPSESSID=abc123; Path=/; HttpOnly"] }));
      }
      return Promise.resolve(fakeResponse("<html>results</html>"));
    };
    const fetcher = createSessionFetcher({ rawFetch, sleep: () => Promise.resolve() });

    await fetcher("https://example.sk/search?q=a");

    expect(seenCookieHeaders).toEqual([undefined, "PHPSESSID=abc123"]);
  });

  it("retries up to 3 attempts with 1.5*(attempt+1)s backoff, then throws", async () => {
    let attempts = 0;
    const sleepCalls: number[] = [];
    const rawFetch: RawFetcher = (url) => {
      if (url === "https://example.sk/") return Promise.resolve(fakeResponse("<html></html>"));
      attempts += 1;
      return Promise.reject(new Error("boom"));
    };
    const fetcher = createSessionFetcher({
      rawFetch,
      sleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
    });

    await expect(fetcher("https://example.sk/search?q=a")).rejects.toThrow(/fetch zlyhal aj po opakovaných/);
    expect(attempts).toBe(3);
    expect(sleepCalls).toEqual([1500, 3000, 4500]);
  });

  it("retries on a non-2xx HTTP status, then succeeds on a later attempt", async () => {
    let searchAttempts = 0;
    const rawFetch: RawFetcher = (url) => {
      if (url === "https://example.sk/") return Promise.resolve(fakeResponse("<html></html>"));
      searchAttempts += 1;
      if (searchAttempts < 2) return Promise.resolve(fakeResponse("", { status: 503 }));
      return Promise.resolve(fakeResponse("<html>ok</html>"));
    };
    const fetcher = createSessionFetcher({ rawFetch, sleep: () => Promise.resolve() });

    const text = await fetcher("https://example.sk/search?q=a");

    expect(text).toBe("<html>ok</html>");
    expect(searchAttempts).toBe(2);
  });

  it("captures a Set-Cookie carried on a FAILED (non-2xx) attempt, not just the final success (review finding)", async () => {
    let searchAttempts = 0;
    const seenCookieHeaders: (string | undefined)[] = [];
    const rawFetch: RawFetcher = (url, init) => {
      seenCookieHeaders.push(init.headers["cookie"]);
      if (url === "https://example.sk/") return Promise.resolve(fakeResponse("<html></html>"));
      searchAttempts += 1;
      if (searchAttempts < 2) {
        // A 503 that ALSO issues a fresh session cookie — real servers do
        // this (e.g. a load balancer re-routing + stamping a new sticky
        // session cookie on the error response itself).
        return Promise.resolve(fakeResponse("", { status: 503, setCookie: ["retry_session=xyz; Path=/"] }));
      }
      return Promise.resolve(fakeResponse("<html>ok</html>"));
    };
    const fetcher = createSessionFetcher({ rawFetch, sleep: () => Promise.resolve() });

    await fetcher("https://example.sk/search?q=a");

    // [warm-up, 1st (503) attempt, 2nd (success) attempt] — the cookie
    // issued on the FAILED 1st attempt must already be present on the 2nd.
    expect(seenCookieHeaders).toEqual([undefined, undefined, "retry_session=xyz"]);
  });
});

describe("nativeFetcher", () => {
  it("is a stable module-level singleton (identity used for the throttle isReal check)", () => {
    expect(nativeFetcher).toBe(nativeFetcher);
  });
});
