// issue 598: zdieľaná detekcia blokovej stránky Shoptetu (WAF „Access
// temporarily blocked"). Fixtúra je SKUTOČNÁ bloková stránka stiahnutá z
// forestshop.sk 25. 10. 2026 (IP nahradená dokumentačnou 203.0.113.7).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SHOPTET_BLOCKED_CODE,
  ShoptetBlockedError,
  isShoptetBlockPage,
  isShoptetBlockedError,
  isShoptetBlockedMessage,
} from "./blocked.js";

const BLOCK_PAGE = readFileSync(new URL("./fixtures/shoptet-block-page.html", import.meta.url), "utf8");

describe("isShoptetBlockPage", () => {
  it("403 + skutočná bloková stránka Shoptetu → blokované", () => {
    expect(isShoptetBlockPage(403, BLOCK_PAGE)).toBe(true);
  });

  it("bežná 403 bez blokového textu (napr. zakázaný export) → NIE je blok", () => {
    expect(isShoptetBlockPage(403, "<html><body><h1>403 Forbidden</h1></body></html>")).toBe(false);
  });

  it("404 — aj keby telo náhodou obsahovalo text blokovej stránky → NIE je blok (blok je vždy 403)", () => {
    expect(isShoptetBlockPage(404, BLOCK_PAGE)).toBe(false);
  });

  it("200 s bežnou stránkou → NIE je blok", () => {
    expect(isShoptetBlockPage(200, "<html><body>Bunda Forest</body></html>")).toBe(false);
  });

  it("403 so samotným slovenským/českým nadpisom (lokalizovaná varianta) → blokované", () => {
    expect(isShoptetBlockPage(403, "<h1>Prístup dočasne zablokovaný</h1>")).toBe(true);
    expect(isShoptetBlockPage(403, "<h1>Přístup dočasně zablokován</h1>")).toBe(true);
  });
});

describe("ShoptetBlockedError / isShoptetBlockedError", () => {
  it("správa začína kódom shoptet_blocked a nesie kontext", () => {
    const error = new ShoptetBlockedError("prihlásenie do administrácie");
    expect(error.code).toBe(SHOPTET_BLOCKED_CODE);
    expect(error.message.startsWith(`${SHOPTET_BLOCKED_CODE}:`)).toBe(true);
    expect(error.message).toContain("prihlásenie do administrácie");
    expect(isShoptetBlockedError(error)).toBe(true);
  });

  it("obyčajný Error s rovnakou správou (prešiel cez IPC dieťa procesu) sa rozpozná podľa predpony", () => {
    const viaIpc = new Error(new ShoptetBlockedError("prihlásenie do administrácie").message);
    expect(isShoptetBlockedError(viaIpc)).toBe(true);
  });

  it("iná chyba (timeout lokátora, bežná 403) → nie je blok", () => {
    expect(isShoptetBlockedError(new Error("locator.fill: Timeout 30000ms exceeded."))).toBe(false);
    expect(isShoptetBlockedError(new Error("Stiahnutie exportu objednávok zlyhalo so stavom 403"))).toBe(false);
    expect(isShoptetBlockedError("shoptet_blocked: reťazec, nie Error")).toBe(false);
  });

  it("isShoptetBlockedMessage číta job_run.error_message (null = nie)", () => {
    expect(isShoptetBlockedMessage(new ShoptetBlockedError("x").message)).toBe(true);
    expect(isShoptetBlockedMessage("locator.fill: Timeout")).toBe(false);
    expect(isShoptetBlockedMessage(null)).toBe(false);
  });
});
