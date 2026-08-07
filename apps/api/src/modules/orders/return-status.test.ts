import { describe, expect, it } from "vitest";
import { classifyFinishedReturnStatus, classifyReturnStatus, returnUpozornenieDedupKey } from "./return-status.js";

// issue 297: "Vybavená výmena"/"Vybavený Dobropis" sú HOTOVÉ stavy — appka
// pre ne NEZAKLADÁ kartu (`classifyReturnStatus` vracia `null`), namiesto
// toho existujúcu otvorenú kartu AUTOMATICKY ZATVÁRA
// (`classifyFinishedReturnStatus`, `.claude/rules/upozornenia.md`).
// "Vratený tovar" ostáva jediný AKTÍVNY stav.
describe("classifyReturnStatus", () => {
  it("rozpozná jediný živo overený AKTÍVNY vrátkový stav", () => {
    expect(classifyReturnStatus("Vratený tovar")).toBe("vrátený tovar");
  });

  it("HOTOVÉ stavy (Vybavená výmena, Vybavený Dobropis) NEZAKLADAJÚ kartu — vrátia null", () => {
    expect(classifyReturnStatus("Vybavená výmena")).toBeNull();
    expect(classifyReturnStatus("Vybavený Dobropis")).toBeNull();
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

describe("classifyFinishedReturnStatus", () => {
  it("rozpozná presne dva živo overené HOTOVÉ vrátkové stavy", () => {
    expect(classifyFinishedReturnStatus("Vybavená výmena")).toBe("vybavená výmena");
    expect(classifyFinishedReturnStatus("Vybavený Dobropis")).toBe("vybavený dobropis");
  });

  it("AKTÍVNY stav (Vratený tovar) a bežné stavy NIE SÚ hotové — vrátia null", () => {
    expect(classifyFinishedReturnStatus("Vratený tovar")).toBeNull();
    expect(classifyFinishedReturnStatus("Vybavuje sa")).toBeNull();
    expect(classifyFinishedReturnStatus("")).toBeNull();
  });

  it("normalizuje (NFC + orez) rovnako ako `classifyReturnStatus`", () => {
    expect(classifyFinishedReturnStatus("  Vybavený Dobropis  ")).toBe("vybavený dobropis");
    expect(classifyFinishedReturnStatus("Vybavená výmena".normalize("NFD"))).toBe("vybavená výmena");
  });
});

describe("returnUpozornenieDedupKey", () => {
  it("je stabilný na objednávku, nezávislý od konkrétneho pod-stavu", () => {
    expect(returnUpozornenieDedupKey("20260805")).toBe("vratenie:20260805");
  });
});
