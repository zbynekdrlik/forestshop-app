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
      rawScore: 0,
      codeHit: false,
    });
    expect(candidates[1]?.name).toBe("DEERHUNTER Strike Extreme Pull-Over Trousers - ochranné nohavice");
    expect(candidates[2]?.name).toBe("DEERHUNTER Lady Excape Winter Trousers - dámske nohavice");
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
