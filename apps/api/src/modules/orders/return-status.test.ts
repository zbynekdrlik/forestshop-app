import { describe, expect, it } from "vitest";
import { classifyReturnStatus, returnUpozornenieDedupKey } from "./return-status.js";

describe("classifyReturnStatus", () => {
  it("rozpozná presne tri živo overené vrátkové stavy", () => {
    expect(classifyReturnStatus("Vratený tovar")).toBe("vrátený tovar");
    expect(classifyReturnStatus("Vybavená výmena")).toBe("vybavená výmena");
    expect(classifyReturnStatus("Vybavený Dobropis")).toBe("vybavený dobropis");
  });

  it("bežné (nevrátkové) stavy vrátia null", () => {
    expect(classifyReturnStatus("Vybavuje sa")).toBeNull();
    expect(classifyReturnStatus("Vybavená")).toBeNull();
    expect(classifyReturnStatus("Stornovaná")).toBeNull();
    expect(classifyReturnStatus("")).toBeNull();
  });

  it("normalizuje (NFC + orez) rovnako ako `order.status_name`, nikdy bajtovo presnú zhodu", () => {
    expect(classifyReturnStatus("  Vratený tovar  ")).toBe("vrátený tovar");
    // NFD (rozložená diakritika) — rovnaký zámer ako `parser.test.ts`'s
    // existujúca `normalizeStatusName` kontrola.
    expect(classifyReturnStatus("Vratený tovar".normalize("NFD"))).toBe("vrátený tovar");
  });
});

describe("returnUpozornenieDedupKey", () => {
  it("je stabilný na objednávku, nezávislý od konkrétneho pod-stavu", () => {
    expect(returnUpozornenieDedupKey("20260805")).toBe("vratenie:20260805");
  });
});
