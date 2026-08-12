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
      rawScore: 0,
      codeHit: false,
    });
    expect(candidates[1]?.name).toBe("Pánske poľovnícke nohavice Michal");
    expect(candidates[2]?.name).toBe("Poľovnícke nohavice Deerhunter Ram");
  });

  it("dedups the repeated card by canonical URL", () => {
    const candidates = parseOdimonSearch(VYSLEDKY);
    const urls = candidates.map((candidate) => candidate.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("returns an empty list when .product-list__results has no cards", () => {
    expect(parseOdimonSearch(PRAZDNE)).toEqual([]);
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
