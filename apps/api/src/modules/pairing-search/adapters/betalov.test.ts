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
      // issue 397: `img.product-image` je REÁLNE prítomný v tejto naživo
      // zachytenej fixtúre (nebolo treba dopĺňať).
      imageUrl: "https://www.huntingshop.eu/upload/images/product/md__14695-detske-outdoorove-nohavice-combi-1.webp",
      rawScore: 0,
      codeHit: false,
    });
    expect(candidates[1]?.name).toBe("Armotion Class-T dámske nohavice");
    expect(candidates[1]?.imageUrl).toBe("https://www.huntingshop.eu/upload/images/product/md__14306-armotion-class-t-damske-nohavice-1.webp");
    expect(candidates[2]?.name).toBe("WADERA - Detské krátke nohavice - Hnedé");
    expect(candidates[2]?.imageUrl).toBe("https://www.huntingshop.eu/upload/images/product/md__14266-wadera-detske-kratke-nohavice-hnede-1.webp");
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

  // Syntetické HTML zlomky (nie živo stiahnuté fixtúry) — testujú
  // ŠTRUKTURÁLNE vetvy (chýbajúci mh-100/chýbajúci #snippet--productList),
  // nie nuansu reálneho markupu.
  it("falls back to .product-title a href when a.mh-100 is missing on the card", () => {
    const html =
      '<div class="product-col"><h3 class="product-title"><a href="len-title-odkaz">Len title odkaz</a></h3></div>';
    expect(parseBetalovSearch(html)).toEqual([
      {
        name: "Len title odkaz",
        url: "https://www.huntingshop.eu/len-title-odkaz",
        code: null,
        price: null,
        imageUrl: null,
        rawScore: 0,
        codeHit: false,
      },
    ]);
  });

  it("searches the whole document for .product-col when #snippet--productList is absent", () => {
    const html =
      '<div class="product-col"><a href="/x" class="mh-100">img</a>' +
      '<h3 class="product-title"><a href="x">Bez snippetu</a></h3></div>';
    expect(parseBetalovSearch(html)).toEqual([
      {
        name: "Bez snippetu",
        url: "https://www.huntingshop.eu/x",
        code: null,
        price: null,
        imageUrl: null,
        rawScore: 0,
        codeHit: false,
      },
    ]);
  });

  it("skips a single malformed href without losing the other, valid cards (review finding, issue 387 E2)", () => {
    const html =
      '<div class="product-col"><a href="http://[" class="mh-100">img</a>' +
      '<h3 class="product-title"><a href="http://[">Pokazená</a></h3></div>' +
      '<div class="product-col"><a href="/dobra" class="mh-100">img</a>' +
      '<h3 class="product-title"><a href="dobra">Dobrá karta</a></h3></div>';
    expect(parseBetalovSearch(html)).toEqual([
      {
        name: "Dobrá karta",
        url: "https://www.huntingshop.eu/dobra",
        code: null,
        price: null,
        imageUrl: null,
        rawScore: 0,
        codeHit: false,
      },
    ]);
  });

  it("issue 397: šumový obrázok (.svg ikonka) sa filtruje na imageUrl null, aj keď path nie je vylúčená", () => {
    const html =
      '<div class="product-col"><a href="/x" class="mh-100"><img class="product-image" src="/upload/images/icons/cart.svg"></a>' +
      '<h3 class="product-title"><a href="x">Produkt s ikonkou namiesto fotky</a></h3></div>';
    expect(parseBetalovSearch(html)[0]?.imageUrl).toBeNull();
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
