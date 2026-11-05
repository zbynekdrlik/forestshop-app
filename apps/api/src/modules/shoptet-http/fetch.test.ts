// issue 598: `shoptetFetch` — JEDINÝ vstup na forestshop.sk pre HTTP fetchery
// (sitemap, sonda, feed, exporty katalógu a objednávok). Zmení blokovú
// stránku na `ShoptetBlockedError` a započíta požiadavku do počítadla behu.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShoptetBlockedError } from "./blocked.js";
import { shoptetFetch } from "./fetch.js";
import { attachShoptetRequestTally, newShoptetRequestTally, noteShoptetAdminSession, runWithShoptetRequestTally } from "./request-tally.js";

const BLOCK_PAGE = readFileSync(new URL("./fixtures/shoptet-block-page.html", import.meta.url), "utf8");

function stubFetchResponse(make: () => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(make())),
  );
}

describe("shoptetFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bloková stránka (403 + text) → vyhodí ShoptetBlockedError s kontextom", async () => {
    stubFetchResponse(() => new Response(BLOCK_PAGE, { status: 403 }));
    await expect(shoptetFetch("https://www.forestshop.sk/x/", {}, "sonda produktu")).rejects.toBeInstanceOf(ShoptetBlockedError);
    await expect(shoptetFetch("https://www.forestshop.sk/x/", {}, "sonda produktu")).rejects.toThrow(/^shoptet_blocked:.*sonda produktu/);
  });

  it("bežná 403 bez blokového textu → vráti odpoveď nezmenenú (volajúci ju spracuje po svojom), telo ostáva čitateľné", async () => {
    stubFetchResponse(() => new Response("Forbidden", { status: 403 }));
    const response = await shoptetFetch("https://www.forestshop.sk/x/", {}, "export");
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
  });

  it("404 → vráti odpoveď nezmenenú", async () => {
    stubFetchResponse(() => new Response("nie je", { status: 404 }));
    const response = await shoptetFetch("https://www.forestshop.sk/x/", {}, "sonda");
    expect(response.status).toBe(404);
  });
});

describe("počítadlo požiadaviek na forestshop.sk (job_run.detail)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("každá požiadavka (aj zablokovaná) sa započíta do počítadla AKTUÁLNEHO behu", async () => {
    const tally = newShoptetRequestTally();
    let call = 0;
    stubFetchResponse(() => {
      call += 1;
      return call < 3 ? new Response("ok", { status: 200 }) : new Response(BLOCK_PAGE, { status: 403 });
    });
    await runWithShoptetRequestTally(tally, async () => {
      await shoptetFetch("https://www.forestshop.sk/a/", {}, "a");
      await shoptetFetch("https://www.forestshop.sk/b/", {}, "b");
      await shoptetFetch("https://www.forestshop.sk/c/", {}, "c").catch(() => undefined);
      noteShoptetAdminSession();
    });
    expect(tally).toEqual({ requests: 3, blocked: 1, adminSessions: 1 });
  });

  it("dva súbežné behy majú oddelené počítadlá (AsyncLocalStorage, nie globálny stav)", async () => {
    stubFetchResponse(() => new Response("ok", { status: 200 }));
    const a = newShoptetRequestTally();
    const b = newShoptetRequestTally();
    await Promise.all([
      runWithShoptetRequestTally(a, async () => {
        await shoptetFetch("https://www.forestshop.sk/1/", {}, "1");
        await shoptetFetch("https://www.forestshop.sk/2/", {}, "2");
      }),
      runWithShoptetRequestTally(b, async () => {
        await shoptetFetch("https://www.forestshop.sk/3/", {}, "3");
      }),
    ]);
    expect(a.requests).toBe(2);
    expect(b.requests).toBe(1);
  });

  it("mimo behu (žiadne počítadlo) sa požiadavka normálne vykoná, len sa nikam nepočíta", async () => {
    stubFetchResponse(() => new Response("ok", { status: 200 }));
    const response = await shoptetFetch("https://www.forestshop.sk/a/", {}, "a");
    expect(response.status).toBe(200);
  });

  it("attachShoptetRequestTally: pridá počty do objektového detailu, prázdne počítadlo detail nemení", () => {
    const empty = newShoptetRequestTally();
    expect(attachShoptetRequestTally({ status: "ok" }, empty)).toEqual({ status: "ok" });
    expect(attachShoptetRequestTally(null, empty)).toBeNull();

    const used = { requests: 5, blocked: 1, adminSessions: 0 };
    expect(attachShoptetRequestTally({ status: "ok" }, used)).toEqual({ status: "ok", shoptetRequests: 5, shoptetBlocked: 1 });
    expect(attachShoptetRequestTally(null, used)).toEqual({ shoptetRequests: 5, shoptetBlocked: 1 });
    expect(attachShoptetRequestTally(undefined, { requests: 0, blocked: 0, adminSessions: 2 })).toEqual({ shoptetAdminSessions: 2 });
    // Nie-objektový detail (pole/primitív) sa nikdy nerozbije — počty sa pridajú vedľa.
    expect(attachShoptetRequestTally([1, 2], used)).toEqual({ result: [1, 2], shoptetRequests: 5, shoptetBlocked: 1 });
  });
});
