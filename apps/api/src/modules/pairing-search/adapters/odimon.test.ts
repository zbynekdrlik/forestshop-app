import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { odimonAdapter, parseOdimonSearch } from "./odimon.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
}

const VYSLEDKY = fixture("odimon-vysledky-nohavice.html");
const PRAZDNE = fixture("odimon-prazdne-vysledky.html");

describe("parseOdimonSearch", () => {
  it("extracts name from img[alt] and url from a.product-card, code/price stay null", () => {
    const candidates = parseOdimonSearch(VYSLEDKY);
    // 4 karty vo fixtúre, karta 4 je duplikát karty 1 — po dedupe 3.
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toEqual({
      name: "Termoprádlo nohavice modal Termovel",
      url: "https://www.odimon.sk/obuv-a-oblecenie/polovnicke-oblecenie/polovnicke-termopradlo/termopradlo-nohavice-modal-termovel",
      code: null,
      price: null,
      // issue 397: `data-src` (skutočný lazy-load obrázok) uprednostnené
      // pred `src` (na tejto doméne VŽDY `no-image.png` placeholder).
      imageUrl:
        "https://www.odimon.sk/buxus/images/cache/product_catalog.eshop_product_list/produkty/katalog_produktov/obuv_a_oblecenie/polovnicke_termopradlo/termopradlo_nohavice_modal_termovel/20161611121146-termovelspodky.jpg",
      rawScore: 0,
      codeHit: false,
    });
    expect(candidates[1]?.name).toBe("Pánske poľovnícke nohavice Michal");
    // issue 397: karty 2-3 nemajú `data-src`/`src` vo fixtúre (zámerne) ->
    // žiadny obrázok sa nájsť nedá.
    expect(candidates[1]?.imageUrl).toBeNull();
    expect(candidates[2]?.name).toBe("Poľovnícke nohavice Deerhunter Ram");
    expect(candidates[2]?.imageUrl).toBeNull();
  });

  it("dedups the repeated card by canonical URL", () => {
    const candidates = parseOdimonSearch(VYSLEDKY);
    const urls = candidates.map((candidate) => candidate.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("returns an empty list when .product-list__results has no cards", () => {
    expect(parseOdimonSearch(PRAZDNE)).toEqual([]);
  });

  // Syntetické HTML zlomky (nie živo stiahnuté fixtúry) — testujú
  // ŠTRUKTURÁLNE vetvy, nie nuansu reálneho markupu.
  it("searches the whole document for a.product-card when .product-list__results is absent", () => {
    const html = '<a class="product-card" href="https://www.odimon.sk/x"><img alt="Bez kontajnera"></a>';
    expect(parseOdimonSearch(html)).toEqual([
      {
        name: "Bez kontajnera",
        url: "https://www.odimon.sk/x",
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
      '<div class="product-list__results">' +
      '<a class="product-card" href="http://["><img alt="Pokazená"></a>' +
      '<a class="product-card" href="https://www.odimon.sk/dobra"><img alt="Dobrá karta"></a>' +
      "</div>";
    expect(parseOdimonSearch(html)).toEqual([
      {
        name: "Dobrá karta",
        url: "https://www.odimon.sk/dobra",
        code: null,
        price: null,
        imageUrl: null,
        rawScore: 0,
        codeHit: false,
      },
    ]);
  });

  it("issue 397: samotný src bez data-src (no-image.png placeholder) sa NIKDY nezoberie ako obrázok", () => {
    const html =
      '<a class="product-card" href="https://www.odimon.sk/bez-obrazka">' +
      '<img alt="Bez obrázka" src="/buxus/images/cache/product_catalog.eshop_product_list/no-image.png"></a>';
    expect(parseOdimonSearch(html)[0]?.imageUrl).toBeNull();
  });
});

describe("odimonAdapter", () => {
  it("builds the URL-encoded search URL against odimon.sk", () => {
    expect(odimonAdapter.buildSearchUrl("nohavice s medzerou")).toBe(
      "https://www.odimon.sk/vysledky-vyhladavania?term=nohavice%20s%20medzerou",
    );
  });

  it("carries the adapterKey matching supplier.adapter_key", () => {
    expect(odimonAdapter.adapterKey).toBe("odimon");
    expect(odimonAdapter.baseUrl).toBe("https://www.odimon.sk");
  });
});
