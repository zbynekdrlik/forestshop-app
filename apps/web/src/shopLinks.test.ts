import { describe, expect, it } from "vitest";
import { feedOnlyProductLink, ourProductLink, ourProductUrl } from "./shopLinks.js";

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

describe("feedOnlyProductLink (issue 329)", () => {
  it("vráti priamu adresu z feedu, keď je k dispozícii", () => {
    expect(feedOnlyProductLink("https://www.forestshop.sk/bunda/?variantId=4211")).toBe(
      "https://www.forestshop.sk/bunda/?variantId=4211",
    );
  });

  it("chýbajúca adresa (null) sa nenahradí — vráti null, nikdy vyhľadávanie", () => {
    expect(feedOnlyProductLink(null)).toBeNull();
  });

  it("prázdny reťazec sa berie rovnako ako chýbajúca adresa", () => {
    expect(feedOnlyProductLink("")).toBeNull();
  });
});
