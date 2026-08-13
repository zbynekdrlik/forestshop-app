import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseWetlandSearch, wetlandAdapter } from "./wetland.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
}

const VYSLEDKY = fixture("wetland-vysledky-nohavice.html");
const PRAZDNE = fixture("wetland-prazdne-vysledky.html");

describe("parseWetlandSearch", () => {
  it("extracts name/url from real search-result markup, code/price stay null", () => {
    const candidates = parseWetlandSearch(VYSLEDKY);
    // 4 karty vo fixtúre, ale karta 4 je duplikát karty 1 (iný fragment) —
    // po dedupe zostávajú 3 (`.claude/rules/pairing-search.md` doslovný port).
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toEqual({
      name: "DEERHUNTER Pro Gamekeeper Boot Trousers - poľovnícke nohavice",
      url: "https://www.wetland.sk/nohavice/deerhunter-pro-gamekeeper-boot-trousers-polovnicke-nohavice-111-592",
      code: null,
      price: null,
      // issue 397: prvá karta má REÁLNU `.product-miniature` obal-struktúru
      // (`data-full-size-image-url` uprednostnené pred menším `src`).
      imageUrl: "https://www.wetland.sk/7593-home_default/deerhunter-pro-gamekeeper-boot-trousers-polovnicke-nohavice.jpg",
      rawScore: 0,
      codeHit: false,
    });
    expect(candidates[1]?.name).toBe("DEERHUNTER Strike Extreme Pull-Over Trousers - ochranné nohavice");
    // issue 397: karty 2-3 nemajú `.product-miniature` obal vo fixtúre
    // (zámerne, viď fixtúrov komentár) -> žiadny obrázok sa nájsť nedá.
    expect(candidates[1]?.imageUrl).toBeNull();
    expect(candidates[2]?.name).toBe("DEERHUNTER Lady Excape Winter Trousers - dámske nohavice");
    expect(candidates[2]?.imageUrl).toBeNull();
  });

  it("strips the #/variant fragment and dedups the two occurrences by canonical URL", () => {
    const candidates = parseWetlandSearch(VYSLEDKY);
    const urls = candidates.map((candidate) => candidate.url);
    // Žiadna URL neobsahuje fragment.
    for (const url of urls) {
      expect(url).not.toContain("#");
    }
    // Žiadny duplikát.
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("returns an empty list when the search page has no results", () => {
    expect(parseWetlandSearch(PRAZDNE)).toEqual([]);
  });

  // Synteticky zostavený HTML zlomok (nie živo stiahnutá fixtúra) — testuje
  // ŠTRUKTURÁLNU vetvu (chýbajúci primárny selektor), nie nuansu reálneho
  // markupu, ktorá by inak zaslúžila commitnutú fixtúru.
  it("falls back to a.product-miniature__link when the primary title selector matches nothing", () => {
    const html =
      '<a class="product-miniature__link" href="/x" title="Miniatúra produktu">' +
      '<img alt="obrázok"></a>';
    expect(parseWetlandSearch(html)).toEqual([
      { name: "Miniatúra produktu", url: "https://www.wetland.sk/x", code: null, price: null, imageUrl: null, rawScore: 0, codeHit: false },
    ]);
  });

  it("skips a single malformed href without losing the other, valid cards (review finding, issue 387 E2)", () => {
    const html =
      '<div class="product-miniature__title"><a class="link" href="http://[">Pokazená karta</a></div>' +
      '<div class="product-miniature__title"><a class="link" href="/nohavice/dobra">Dobrá karta</a></div>';
    expect(parseWetlandSearch(html)).toEqual([
      {
        name: "Dobrá karta",
        url: "https://www.wetland.sk/nohavice/dobra",
        code: null,
        price: null,
        imageUrl: null,
        rawScore: 0,
        codeHit: false,
      },
    ]);
  });
});

describe("wetlandAdapter", () => {
  it("builds the URL-encoded search URL against wetland.sk", () => {
    expect(wetlandAdapter.buildSearchUrl("nohavice s medzerou")).toBe(
      "https://www.wetland.sk/vyhladavanie?controller=search&s=nohavice%20s%20medzerou",
    );
  });

  it("carries the adapterKey matching supplier.adapter_key", () => {
    expect(wetlandAdapter.adapterKey).toBe("wetland");
    expect(wetlandAdapter.baseUrl).toBe("https://www.wetland.sk");
  });
});
