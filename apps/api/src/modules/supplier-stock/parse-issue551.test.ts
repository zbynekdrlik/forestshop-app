// wetland.sk (PrestaShop 1.7/8) per-veľkosť pravidlo — issue 551.
// Fáza 1 (issue 549) čítala dostupnosť KOMBINÁCIE zvolenej príponou URL, ale
// zapisovala ju ako PLOŠNÝ riadok `size_label=''` (bola vo `VISIBLE_AVAILABILITY_RULES`)
// → `restock/queries.ts` blanket-párovanie prepínalo VŠETKY naše veľkosti toho
// odkazu, hoci u dodávateľa je skladom len JEDNA (živý nález PROD 18. 9. 2026).
// Fix (issue 551): wetland pribudlo aj do `SIZE_AVAILABILITY_RULES` — čítač
// vráti JEDNU kombináciu (veľkosť z `data-product.attributes[*].name` +
// quantity + krížová kontrola JSON-LD z issue 549). `matchSizeLabel` spáruje
// LEN našu zhodnú veľkosť; ostatné → `unknown` (ako lasting/chiruca). Produkt
// bez `attributes` → prázdno → `run.ts` blanket vetva (issue 549 zachované).
// Vlastný súbor (rovnaký dôvod ako parse-issue307/330/332/549 — max-lines 400).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchSizeLabel, parsePage, parseSizeAvailability } from "./parse.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const ERIC = fixture("wetland-skladom-eric-kosela-542-8845.html");
const BAMBOO = fixture("wetland-skladom-bamboo-tricko.html");
const WESTON = fixture("wetland-vypredane-weston-tricko.html");
const BALLISTOL = fixture("wetland-skladom-ballistol-olej-4478.html");

const ERIC_URL = "https://www.wetland.sk/kosele/deerhunter-eric-shirt-polovnicka-kosela-542-8845";
const BAMBOO_URL = "https://www.wetland.sk/tricka-a-natelniky/deerhunter-bamboo-t-shirt-tricko-4374-19868";
const WESTON_URL = "https://www.wetland.sk/tricka-a-natelniky/deerhunter-weston-t-shirt-tricko-4373-14154";
const BALLISTOL_URL = "https://www.wetland.sk/doplnky/ballistol-universal-oil-035l-olej-na-cistenie-4478";

describe("parseSizeAvailability — issue 551: wetland.sk vráti JEDNU kombináciu (veľkosť z attributes)", () => {
  it("Eric košeľa 542-8845 → len kombinácia 39/40 (quantity 2, JSON-LD InStock) available", () => {
    expect(parseSizeAvailability(ERIC, ERIC_URL)).toEqual([{ sizeLabel: "39/40", availability: "available" }]);
  });

  it("bamboo 4374-19868 → veľkosť L (quantity 8, InStock) available", () => {
    expect(parseSizeAvailability(BAMBOO, BAMBOO_URL)).toEqual([{ sizeLabel: "L", availability: "available" }]);
  });

  it("weston 4373-14154 → veľkosť S (quantity 0, BackOrder) unavailable", () => {
    expect(parseSizeAvailability(WESTON, WESTON_URL)).toEqual([{ sizeLabel: "S", availability: "unavailable" }]);
  });

  it("produkt BEZ attributes (olej 4478) → null (per-veľkosť sa neaplikuje, run.ts padne na blanket)", () => {
    expect(parseSizeAvailability(BALLISTOL, BALLISTOL_URL)).toBeNull();
  });

  it("rozpor quantity vs JSON-LD (aj s attributes) → null (fail-closed, disciplína issue 549)", () => {
    // Kombinácia má veľkosť "M", quantity 5 (podľa quantity available), ale
    // Product JSON-LD hlási BackOrder → rozpor → žiadny hit (nikdy available
    // na rozpore). Krížová kontrola JSON-LD ostáva z issue 549.
    const html =
      '<html><head><script type="application/ld+json">' +
      '{"@type":"Product","offers":{"@type":"Offer","availability":"https://schema.org/BackOrder"}}' +
      "</script></head><body>" +
      '<div id="product-details" data-product="{&quot;id_product&quot;:1,&quot;id_product_attribute&quot;:2,' +
      "&quot;quantity&quot;:5,&quot;availability_message&quot;:&quot;Skladom&quot;," +
      "&quot;attributes&quot;:{&quot;1&quot;:{&quot;name&quot;:&quot;M&quot;,&quot;group&quot;:&quot;Veľkosť&quot;}}}\">x</div>" +
      "</body></html>";
    expect(parseSizeAvailability(html, ERIC_URL)).toBeNull();
  });

  it("iná doména (bez wetland pravidla) → null", () => {
    expect(parseSizeAvailability(ERIC, "https://www.huntingshop.eu/p/1")).toBeNull();
  });
});

describe("matchSizeLabel nad wetland kombináciou — issue 551: naše veľkosti odkazu 542-8845", () => {
  it("naše ['39/40','41/42','43/44'] → spáruje sa LEN 39/40, ostatné bez hitu (unknown)", () => {
    const sizes = parseSizeAvailability(ERIC, ERIC_URL);
    expect(sizes).not.toBeNull();
    const supplierLabels = (sizes ?? []).map((s) => s.sizeLabel);
    expect(matchSizeLabel("39/40", supplierLabels)).toBe("39/40");
    expect(matchSizeLabel("41/42", supplierLabels)).toBeNull();
    expect(matchSizeLabel("43/44", supplierLabels)).toBeNull();
  });
});

describe("parsePage — issue 551: wetland BEZ veľkostí ostáva blanket (issue 549 nezmenené)", () => {
  it("olej 4478 (bez attributes) → available, source text (blanket cez VISIBLE pravidlo)", () => {
    const result = parsePage(BALLISTOL, BALLISTOL_URL);
    expect(result.availability).toBe("available");
    expect(result.source).toBe("text");
    expect(result.availabilityText).toBe("Skladom – ihneď k odberu");
  });

  it("wetland VISIBLE pravidlo naďalej funguje aj pre stránku s attributes (bamboo → available)", () => {
    // Doplnenie attributes do fixtúry nesmie rozbiť issue 549 VISIBLE cestu —
    // quantity + JSON-LD rozhodujú rovnako ako predtým.
    expect(parsePage(BAMBOO, BAMBOO_URL).availability).toBe("available");
  });
});
