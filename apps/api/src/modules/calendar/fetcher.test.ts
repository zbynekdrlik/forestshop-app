import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpIcsFetcher } from "./fetcher.js";

// issue 309: `fetch` je VŽDY stubovaná globálne (`vi.stubGlobal`, rovnaký
// vzor ako `catalog/fetcher.test.ts`) — tento súbor sa NIKDY nepripája na
// skutočný Google.

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

describe("createHttpIcsFetcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("vráti stiahnuté telo ako text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("BEGIN:VCALENDAR\r\nEND:VCALENDAR")));
    const fetcher = createHttpIcsFetcher("https://calendar.example.invalid/private-token/basic.ics");
    await expect(fetcher()).resolves.toBe("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
  });

  it("HTTP chyba (napr. 404 — odvolaná/zmazaná tajná adresa) sa vyhodí BEZ URL v hláške", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("Not Found", 404)));
    const fetcher = createHttpIcsFetcher("https://calendar.example.invalid/private-tajny-token/basic.ics");
    await expect(fetcher()).rejects.toThrow(/HTTP 404/);
    // Chybová hláška NIKDY nesmie obsahovať samotnú tajnú adresu (tá nesie
    // token PRIAMO V CESTE, nie len v query parametri — `fetcher.ts`'s
    // vlastný komentár).
    await fetcher().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toMatch(/tajny-token/);
      expect(message).not.toMatch(/calendar\.example\.invalid/);
    });
  });

  it("odmietne (vyhodí), keď stiahnuté telo prekročí strop veľkosti", async () => {
    const huge = "x".repeat(11 * 1024 * 1024);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse(huge)));
    const fetcher = createHttpIcsFetcher("https://calendar.example.invalid/private-token/basic.ics");
    await expect(fetcher()).rejects.toThrow(/veľkosť/);
  });
});
