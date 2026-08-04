// issue 226: krížová kontrola nášho odvodeného `variant.state` proti
// Shoptetovej VLASTNEJ dostupnosti z feedu pre porovnávače (`g:availability`).
// `compareStateToFeed` je čistá funkcia — žiadna databáza, žiadna sieť.

import { describe, expect, it } from "vitest";
import { compareStateToFeed } from "./feed-cross-check.js";

describe("compareStateToFeed", () => {
  it("feed 'in stock' + naše sellable = zhoda", () => {
    expect(compareStateToFeed("sellable", "in stock")).toBe("match");
  });

  it("feed 'in stock' + naše out_of_stock = rozpor", () => {
    expect(compareStateToFeed("out_of_stock", "in stock")).toBe("mismatch");
  });

  it("feed 'in stock' + naše discontinued = rozpor", () => {
    expect(compareStateToFeed("discontinued", "in stock")).toBe("mismatch");
  });

  it("feed 'out of stock' + naše out_of_stock = zhoda", () => {
    expect(compareStateToFeed("out_of_stock", "out of stock")).toBe("match");
  });

  it("feed 'out of stock' + naše discontinued = zhoda (obe znamenajú nekúpiteľné)", () => {
    expect(compareStateToFeed("discontinued", "out of stock")).toBe("match");
  });

  it("feed 'out of stock' + naše sellable = rozpor", () => {
    expect(compareStateToFeed("sellable", "out of stock")).toBe("mismatch");
  });

  it("chýbajúci feed signál (null) = žiadny rozpor, nikdy zhoda ani rozpor", () => {
    expect(compareStateToFeed("sellable", null)).toBe("no_signal");
    expect(compareStateToFeed("out_of_stock", null)).toBe("no_signal");
  });

  it("prázdny/neznámy text sa berie ako chýbajúci signál, nikdy ako rozpor", () => {
    expect(compareStateToFeed("sellable", "")).toBe("no_signal");
    expect(compareStateToFeed("out_of_stock", "preorder")).toBe("no_signal");
  });

  it("je tolerantná na veľké písmená a okrajové medzery (nepreverené v realite, ale vzor iných polí)", () => {
    expect(compareStateToFeed("sellable", "  In Stock  ")).toBe("match");
  });
});
