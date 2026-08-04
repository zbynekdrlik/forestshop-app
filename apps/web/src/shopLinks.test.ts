import { describe, expect, it } from "vitest";
import { ourProductLink, ourProductUrl } from "./shopLinks.js";

describe("ourProductLink (issue 220)", () => {
  it("uprednostní priamu adresu z feedu aj s výberom veľkosti", () => {
    expect(
      ourProductLink("61276/M", "https://www.forestshop.sk/tricko-hart-aktiva-z/?variantId=35451"),
    ).toBe("https://www.forestshop.sk/tricko-hart-aktiva-z/?variantId=35451");
  });

  it("bez adresy z feedu padne späť na vyhľadávanie podľa kódu", () => {
    expect(ourProductLink("61276/M", null)).toBe(ourProductUrl("61276/M"));
  });

  it("prázdny reťazec sa berie rovnako ako chýbajúca adresa", () => {
    expect(ourProductLink("15314", "")).toBe(ourProductUrl("15314"));
  });
});
