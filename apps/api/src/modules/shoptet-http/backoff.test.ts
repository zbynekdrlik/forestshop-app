// issue 598: po skutočnej blokovej stránke nejde 60 min na forestshop.sk nič.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runShoptetImportIsolated } from "../shoptet-writeback/playwright-import.js";
import { guardShoptetAdminSession, isShoptetBackoffActive, noteShoptetBlocked, resetShoptetBackoff, SHOPTET_BLOCK_BACKOFF_MS } from "./backoff.js";
import { ShoptetBlockedError } from "./blocked.js";
import { shoptetFetch } from "./fetch.js";
import { newShoptetRequestTally, runWithShoptetRequestTally } from "./request-tally.js";

const BLOCK_PAGE = readFileSync(new URL("./fixtures/shoptet-block-page.html", import.meta.url), "utf8");
const URL_A = "https://www.forestshop.sk/a/";
const MINUTE_MS = 60_000;

describe("ochranná pauza po bloku Shoptetu", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let respondWith: () => Response;

  beforeEach(() => {
    resetShoptetBackoff();
    vi.useFakeTimers({ toFake: ["Date"] });
    respondWith = () => new Response(BLOCK_PAGE, { status: 403 });
    fetchMock = vi.fn(() => Promise.resolve(respondWith()));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetShoptetBackoff();
  });

  it("po bloku ďalšia požiadavka na e-shop neodíde a nezapočíta sa do počítadla", async () => {
    await expect(shoptetFetch(URL_A, {}, "export")).rejects.toBeInstanceOf(ShoptetBlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const tally = newShoptetRequestTally();
    await runWithShoptetRequestTally(tally, async () => {
      await expect(shoptetFetch(URL_A, {}, "export katalógu")).rejects.toThrow(/^shoptet_blocked:.*export katalógu/);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tally.requests).toBe(0);
  });

  it("po uplynutí pauzy požiadavka znova odíde, a keď blok skončil, prejde", async () => {
    await expect(shoptetFetch(URL_A, {}, "export")).rejects.toBeInstanceOf(ShoptetBlockedError);
    vi.advanceTimersByTime(SHOPTET_BLOCK_BACKOFF_MS);
    respondWith = () => new Response("ok", { status: 200 });

    const response = await shoptetFetch(URL_A, {}, "export");

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("odmietnutie počas pauzy ju nepredĺži", async () => {
    await expect(shoptetFetch(URL_A, {}, "export")).rejects.toBeInstanceOf(ShoptetBlockedError);
    vi.advanceTimersByTime(SHOPTET_BLOCK_BACKOFF_MS - MINUTE_MS);
    await expect(shoptetFetch(URL_A, {}, "export")).rejects.toBeInstanceOf(ShoptetBlockedError);
    vi.advanceTimersByTime(MINUTE_MS);
    respondWith = () => new Response("ok", { status: 200 });

    await expect(shoptetFetch(URL_A, {}, "export")).resolves.toBeInstanceOf(Response);
  });

  it("nový blok po pauze spustí novú pauzu", async () => {
    await expect(shoptetFetch(URL_A, {}, "export")).rejects.toBeInstanceOf(ShoptetBlockedError);
    vi.advanceTimersByTime(SHOPTET_BLOCK_BACKOFF_MS);
    await expect(shoptetFetch(URL_A, {}, "export")).rejects.toBeInstanceOf(ShoptetBlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(shoptetFetch(URL_A, {}, "export")).rejects.toBeInstanceOf(ShoptetBlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bežná 403 pauzu nespustí", async () => {
    respondWith = () => new Response("Forbidden", { status: 403 });
    await shoptetFetch(URL_A, {}, "export");
    expect(isShoptetBackoffActive()).toBe(false);
  });

  it("relácia do administrácie sa počas pauzy nespustí", async () => {
    noteShoptetBlocked();
    const run = vi.fn(() => Promise.resolve("hotovo"));
    await expect(guardShoptetAdminSession("prihlásenie", run)).rejects.toThrow(/^shoptet_blocked:.*prihlásenie/);
    expect(run).not.toHaveBeenCalled();
  });

  it("blok z dieťa procesu (obyčajný Error so správou) pauzu spustí, iná chyba nie", async () => {
    await expect(guardShoptetAdminSession("x", () => Promise.reject(new Error("timeout")))).rejects.toThrow("timeout");
    expect(isShoptetBackoffActive()).toBe(false);
    await expect(guardShoptetAdminSession("x", () => Promise.reject(new Error("shoptet_blocked: z dieťaťa")))).rejects.toThrow(/^shoptet_blocked:/);
    expect(isShoptetBackoffActive()).toBe(true);
  });

  it("CSV import cez dieťa proces sa počas pauzy vôbec nespustí", async () => {
    noteShoptetBlocked();
    await expect(
      runShoptetImportIsolated({
        config: { loginUrl: "http://127.0.0.1:1/login", importUrl: "http://127.0.0.1:1/import", logUrl: "http://127.0.0.1:1/log", user: "fixture", password: "fixture" },
        csv: Buffer.from("a;b\n"),
        expectedRows: 1,
      }),
    ).rejects.toThrow(/^shoptet_blocked:/);
  });
});
