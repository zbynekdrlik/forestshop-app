// wetland.sk (PrestaShop 1.7/8) overené pravidlo dostupnosti — issue 549.
// Doména mala pole `availability` v data-product JSON aj CSS odznak `.success`
// KONŠTANTNE "available" (allow_oosp:1), takže sa pri issue 230 nenašiel
// overený vypredaný príklad a doména ostala `unknown` (fail-closed, issue 330).
// Živý rozbor 18. 9. našiel dva rozhodujúce SIGNÁLY: `data-product.quantity`
// (skladom 8 / vypredané 0) a JSON-LD `offers.availability` token (InStock vs
// BackOrder). Toto pravidlo číta quantity ako primárny signál a JSON-LD ako
// krížovú kontrolu (rozpor → unknown, rovnaká disciplína ako odimon.sk issue
// 225). Vlastný súbor (rovnaký dôvod ako parse-issue307/330/332 — max-lines 400).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasKnownAvailabilityRule, visibleAvailabilityFor } from "./availability-domain-rules.js";
import { parsePage } from "./parse.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const WETLAND_SKLADOM = fixture("wetland-skladom-bamboo-tricko.html");
const WETLAND_VYPREDANE = fixture("wetland-vypredane-weston-tricko.html");
const WETLAND_ROZPOR = fixture("wetland-rozpor-quantity-vs-jsonld.html");

const SKLADOM_URL = "https://www.wetland.sk/tricka-a-natelniky/deerhunter-bamboo-t-shirt-tricko-4374-19868";
const VYPREDANE_URL = "https://www.wetland.sk/tricka-a-natelniky/deerhunter-weston-t-shirt-tricko-4373-14154";
const ROZPOR_URL = "https://www.wetland.sk/tricka-a-natelniky/testovaci-rozporovy-produkt-9999-99999";

describe("parsePage — issue 549: wetland.sk data-product.quantity + krížová kontrola JSON-LD", () => {
  it("skladom (quantity 8, JSON-LD InStock) → available, source text, availabilityText = availability_message", () => {
    const result = parsePage(WETLAND_SKLADOM, SKLADOM_URL);
    expect(result.availability).toBe("available");
    expect(result.source).toBe("text");
    expect(result.availabilityText).toBe("Skladom – ihneď k odberu");
  });

  it("vypredané (quantity 0, JSON-LD BackOrder) → unavailable, source text, availabilityText = availability_message (NIE JSON-LD token)", () => {
    // Pred pravidlom by wetland padol na generickú vetvu: JSON-LD BackOrder →
    // unavailable, ale source "json_ld" a availabilityText = "https://schema.org/
    // BackOrder". Až pravidlo dá source "text" a availability_message. Zároveň
    // dôkaz, že sa NEBERIE konštantné pole `availability`:"available" ani
    // `.success` odznak — inak by weston vyšiel available.
    const result = parsePage(WETLAND_VYPREDANE, VYPREDANE_URL);
    expect(result.availability).toBe("unavailable");
    expect(result.source).toBe("text");
    expect(result.availabilityText).toBe("Centrálny sklad – doručenie do 3–5 dní");
  });

  it("rozpor (quantity 5 hovorí available, JSON-LD BackOrder hovorí unavailable) → unknown (fail-closed)", () => {
    const result = parsePage(WETLAND_ROZPOR, ROZPOR_URL);
    expect(result.availability).toBe("unknown");
  });

  it("wetland.sk je od issue 549 overená doména (hasKnownAvailabilityRule = true)", () => {
    expect(hasKnownAvailabilityRule(SKLADOM_URL)).toBe(true);
  });

  it("visibleAvailabilityFor číta quantity + availability_message priamo (skladom aj vypredané)", () => {
    expect(visibleAvailabilityFor(SKLADOM_URL, WETLAND_SKLADOM)).toEqual({
      availability: "available",
      text: "Skladom – ihneď k odberu",
    });
    expect(visibleAvailabilityFor(VYPREDANE_URL, WETLAND_VYPREDANE)).toEqual({
      availability: "unavailable",
      text: "Centrálny sklad – doručenie do 3–5 dní",
    });
  });

  it("chýbajúce pole quantity v data-product → unknown (nikdy dohad z konštantného availability poľa)", () => {
    const html =
      '<html><body><div id="product-details" data-product="{&quot;id_product&quot;:1,&quot;availability&quot;:&quot;available&quot;,&quot;availability_message&quot;:&quot;Skladom&quot;}">x</div></body></html>';
    expect(visibleAvailabilityFor(SKLADOM_URL, html)).toEqual({ availability: "unknown", text: "Skladom" });
  });

  it("stránka bez data-product bloku → unknown hit (NIKDY null → nikdy dôvera samotnému JSON-LD)", () => {
    expect(visibleAvailabilityFor(SKLADOM_URL, "<html><body>nič</body></html>")).toEqual({
      availability: "unknown",
      text: "",
    });
  });

  it("code review issue 549: wetland stránka BEZ data-product ale s JSON-LD InStock → unknown, NIKDY available (fail-closed, quantity je primárny signál)", () => {
    // Obrana do hĺbky: keby produktová stránka niekedy nevykreslila
    // product-details blok (drift šablóny) a JSON-LD hlásil InStock, wetland
    // je teraz overená doména (`knownDomain`), takže bez tejto poistky by
    // `parsePage` uveril samotnému JSON-LD a vyhlásil available — presne ten
    // falošný „skladom", ktorému má issue 549 zabrániť. `wetlandVisibleAvailability`
    // preto nikdy nevracia null → JSON-LD je vždy len krížová kontrola.
    const html =
      '<html><head><script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","availability":"https://schema.org/InStock"}}</script></head><body>bez product-details</body></html>';
    const result = parsePage(html, SKLADOM_URL);
    expect(result.availability).toBe("unknown");
  });
});
