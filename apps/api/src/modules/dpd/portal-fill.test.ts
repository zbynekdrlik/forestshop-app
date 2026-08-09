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
