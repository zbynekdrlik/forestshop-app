import { describe, expect, it } from "vitest";
import { consumePreviewToken, issuePreviewToken } from "./preview-tokens.js";

const NOW = new Date("2026-08-02T10:00:00Z");

describe("issuePreviewToken / consumePreviewToken", () => {
  it("token vydaný pre presne (objednávka, variant, typ) sa dá skonzumovať PRESNE raz", () => {
    const token = issuePreviewToken("9001", "A/1", "nedostupne", NOW);
    expect(consumePreviewToken(token, "9001", "A/1", "nedostupne", NOW)).toBe(true);
    expect(consumePreviewToken(token, "9001", "A/1", "nedostupne", NOW)).toBe(false);
  });

  it("token vydaný pre INÝ (objednávka/variant/typ) sa nedá použiť na iný send", () => {
    const token = issuePreviewToken("9001", "A/1", "nedostupne", NOW);
    expect(consumePreviewToken(token, "9002", "A/1", "nedostupne", NOW)).toBe(false);
    expect(consumePreviewToken(token, "9001", "B/1", "nedostupne", NOW)).toBe(false);
    expect(consumePreviewToken(token, "9001", "A/1", "alternativa", NOW)).toBe(false);
  });

  it("neznámy/vymyslený token je vždy neplatný", () => {
    expect(consumePreviewToken("vymyslený-token", "9001", "A/1", "nedostupne", NOW)).toBe(false);
  });

  it("nezhodnutý pokus token AJ TAK skonzumuje (jednorazový, bez ohľadu na výsledok)", () => {
    const token = issuePreviewToken("9001", "A/1", "nedostupne", NOW);
    expect(consumePreviewToken(token, "9999", "A/1", "nedostupne", NOW)).toBe(false);
    // Druhý pokus s ROVNAKÝMI (správnymi) parametrami už zlyhá — token bol
    // zničený prvým (nesprávnym) pokusom.
    expect(consumePreviewToken(token, "9001", "A/1", "nedostupne", NOW)).toBe(false);
  });

  it("token po TOKEN_TTL_MS (15 minút) exspiruje", () => {
    const token = issuePreviewToken("9001", "A/1", "nedostupne", NOW);
    const later = new Date(NOW.getTime() + 16 * 60 * 1000);
    expect(consumePreviewToken(token, "9001", "A/1", "nedostupne", later)).toBe(false);
  });

  it("dva nezávislé náhľady (rôzne typy) dostanú DVA rôzne tokeny, oba platné", () => {
    const tokenA = issuePreviewToken("9001", "A/1", "nedostupne", NOW);
    const tokenB = issuePreviewToken("9001", "A/1", "alternativa", NOW);
    expect(tokenA).not.toBe(tokenB);
    expect(consumePreviewToken(tokenA, "9001", "A/1", "nedostupne", NOW)).toBe(true);
    expect(consumePreviewToken(tokenB, "9001", "A/1", "alternativa", NOW)).toBe(true);
  });
});
