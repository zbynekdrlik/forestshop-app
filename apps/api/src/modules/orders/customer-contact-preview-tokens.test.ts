import { describe, expect, it } from "vitest";
import {
  consumeCustomerContactPreviewToken,
  issueCustomerContactPreviewToken,
} from "./customer-contact-preview-tokens.js";

// issue 500: rovnaký jednorazový-token vzor ako `nedostupne/preview-tokens`,
// len kľúčovaný LEN `orderCode` (e-mail zákazníkovi je per-objednávka).
const NOW = new Date("2026-08-26T10:00:00Z");

describe("issueCustomerContactPreviewToken / consumeCustomerContactPreviewToken", () => {
  it("token vydaný pre presne túto objednávku sa dá skonzumovať PRESNE raz", () => {
    const token = issueCustomerContactPreviewToken("20261438", NOW);
    expect(consumeCustomerContactPreviewToken(token, "20261438", NOW)).toBe(true);
    expect(consumeCustomerContactPreviewToken(token, "20261438", NOW)).toBe(false);
  });

  it("token vydaný pre INÚ objednávku sa nedá použiť na iný send", () => {
    const token = issueCustomerContactPreviewToken("20261438", NOW);
    expect(consumeCustomerContactPreviewToken(token, "20261439", NOW)).toBe(false);
  });

  it("neznámy/vymyslený token je vždy neplatný", () => {
    expect(consumeCustomerContactPreviewToken("vymyslený-token", "20261438", NOW)).toBe(false);
  });

  it("nezhodný pokus token AJ TAK skonzumuje (jednorazový, bez ohľadu na výsledok)", () => {
    const token = issueCustomerContactPreviewToken("20261438", NOW);
    expect(consumeCustomerContactPreviewToken(token, "9999", NOW)).toBe(false);
    // Druhý pokus s ROVNAKÝM (správnym) číslom už zlyhá — token bol zničený
    // prvým (nesprávnym) pokusom.
    expect(consumeCustomerContactPreviewToken(token, "20261438", NOW)).toBe(false);
  });

  it("token po TOKEN_TTL_MS (15 minút) exspiruje", () => {
    const token = issueCustomerContactPreviewToken("20261438", NOW);
    const later = new Date(NOW.getTime() + 16 * 60 * 1000);
    expect(consumeCustomerContactPreviewToken(token, "20261438", later)).toBe(false);
  });

  it("dva nezávislé náhľady dostanú DVA rôzne tokeny, oba platné", () => {
    const tokenA = issueCustomerContactPreviewToken("20261438", NOW);
    const tokenB = issueCustomerContactPreviewToken("20261431", NOW);
    expect(tokenA).not.toBe(tokenB);
    expect(consumeCustomerContactPreviewToken(tokenA, "20261438", NOW)).toBe(true);
    expect(consumeCustomerContactPreviewToken(tokenB, "20261431", NOW)).toBe(true);
  });
});
