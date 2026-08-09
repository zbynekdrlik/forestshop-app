import { describe, expect, it } from "vitest";
import { assertSlovakDeliveryCountry, normalizePhoneForDpd } from "./portal-fill.js";

describe("normalizePhoneForDpd", () => {
  it("strips the +421 prefix", () => {
    expect(normalizePhoneForDpd("+421903123456")).toBe("903123456");
  });

  it("strips the 00421 prefix", () => {
    expect(normalizePhoneForDpd("00421903123456")).toBe("903123456");
  });

  it("strips a leading domestic zero", () => {
    expect(normalizePhoneForDpd("0903123456")).toBe("903123456");
  });

  it("keeps a bare 9-digit number as-is", () => {
    expect(normalizePhoneForDpd("903123456")).toBe("903123456");
  });

  it("throws loudly on a number it cannot recognize as Slovak, never guesses", () => {
    expect(() => normalizePhoneForDpd("+1-555-0100")).toThrow(/slovenské/i);
  });

  // Code review (issue 292, PR 324): pôvodná verzia validovala dĺžku LEN
  // vo vetve "bez rozpoznaného prefixu" — po odstránení prefixu sa už
  // výsledok nekontroloval, takže tieto dva prípady (zle zadaná domáca
  // nula namiesto medzinárodnej predvoľby / nadbytočná číslica) by ticho
  // prešli ako nezmyselné 10/12-miestne "národné" číslo.
  it("throws loudly on 00903123456 (mistaken domestic zero instead of the international prefix) instead of accepting a 10-digit result", () => {
    expect(() => normalizePhoneForDpd("00903123456")).toThrow(/slovenské/i);
  });

  it("throws loudly on 0421903123456 (an extra digit) instead of accepting a 12-digit result", () => {
    expect(() => normalizePhoneForDpd("0421903123456")).toThrow(/slovenské/i);
  });
});

describe("assertSlovakDeliveryCountry", () => {
  it("accepts 'Slovensko'", () => {
    expect(() => { assertSlovakDeliveryCountry("Slovensko"); }).not.toThrow();
  });

  it("accepts case/whitespace variants", () => {
    expect(() => { assertSlovakDeliveryCountry("  SLOVENSKO  "); }).not.toThrow();
    expect(() => { assertSlovakDeliveryCountry("Slovakia"); }).not.toThrow();
  });

  it("throws loudly on a non-Slovak country instead of silently proceeding", () => {
    expect(() => { assertSlovakDeliveryCountry("Česká Republika"); }).toThrow(/slovensk/i);
  });
});
