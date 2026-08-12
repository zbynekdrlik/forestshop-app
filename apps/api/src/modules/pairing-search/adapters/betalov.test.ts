import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { betalovAdapter, parseBetalovSearch } from "./betalov.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
}

const VYSLEDKY = fixture("betalov-vysledky-nohavice.html");
const PRAZDNE = fixture("betalov-prazdne-vysledky.html");

describe("parseBetalovSearch", () => {
  it("extracts name/url from real .product-col cards inside #snippet--productList", () => {
    const candidates = parseBetalovSearch(VYSLEDKY);
    // 5 kariet vo fixtúre: karta 4 je duplikát karty 1 (dedup), karta 5 je
    // vylúčená cesta /kosik (exclusion) — zostávajú 3 skutočné produkty.
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toEqual({
      name: "Detské outdoorové nohavice - Combi",
      url: "https://www.huntingshop.eu/detske-outdoorove-nohavice-combi-14695",
      code: null,
      price: null,
      rawScore: 0,
      codeHit: false,
    });
    expect(candidates[1]?.name).toBe("Armotion Class-T dámske nohavice");
    expect(candidates[2]?.name).toBe("WADERA - Detské krátke nohavice - Hnedé");
  });

  it("dedups the repeated card by canonical URL", () => {
    const candidates = parseBetalovSearch(VYSLEDKY);
    const urls = candidates.map((candidate) => candidate.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.filter((url) => url.endsWith("detske-outdoorove-nohavice-combi-14695"))).toHaveLength(1);
  });

  it("excludes navigation-prefix paths (/kosik) even when they appear as a .product-col card", () => {
    const candidates = parseBetalovSearch(VYSLEDKY);
    expect(candidates.some((candidate) => candidate.url.includes("/kosik"))).toBe(false);
  });

  it("returns an empty list when both tab-panes are empty", () => {
    expect(parseBetalovSearch(PRAZDNE)).toEqual([]);
  });
});

describe("betalovAdapter", () => {
  it("builds the URL-encoded search URL against huntingshop.eu", () => {
    expect(betalovAdapter.buildSearchUrl("nohavice s medzerou")).toBe(
      "https://www.huntingshop.eu/hladanie?search=nohavice%20s%20medzerou",
    );
  });

  it("carries the adapterKey matching supplier.adapter_key", () => {
    expect(betalovAdapter.adapterKey).toBe("betalov");
    expect(betalovAdapter.baseUrl).toBe("https://www.huntingshop.eu");
  });
});
