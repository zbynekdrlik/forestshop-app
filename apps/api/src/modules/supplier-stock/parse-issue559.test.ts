// pyra.eu (WooCommerce / XStore) pravidlo dostupnosti — issue 559 (podticket #555).
// `postid-<id>` z `<body class>` → element s triedou `post-<id>` → token skladu
// (instock / outofstock / onbackorder); krížová kontrola JSON-LD `offers.availability`
// (rozpor → unknown). NIKDY sa nečíta `p.stock` „Na sklade" (súvisiace produkty,
// naživo 6-10× na stránke) ani cudzie `post-<iné id>` triedy. Vlastný súbor
// (eslint max-lines 400). vo.pyra.eu je pokryté sufixovým matchom hosta „pyra.eu".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { visibleAvailabilityFor } from "./availability-domain-rules.js";
import { parsePage } from "./parse.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const SKLADOM = fixture("pyra-skladom-vantage-600-18709.html");
const VYPREDANE = fixture("pyra-vypredane-sidewinder-22111.html");

const SKLADOM_URL = "https://pyra.eu/optika/dialkomery/vantage-600-laser-range-finder-600m/";
const VYPREDANE_URL =
  "https://pyra.eu/optika/puskohlady/sidewinder/sidewinder-ffp-puskohlady-optika/hawke-sidewinder-ffp-30-sf-ir-6-24x56-ffp-moa/";

describe("parsePage / visibleAvailabilityFor — issue 559: pyra.eu class token z post-<postid>", () => {
  it("skladom (post-18709 instock, JSON-LD InStock) → available, source text", () => {
    const result = parsePage(SKLADOM, SKLADOM_URL);
    expect(result.availability).toBe("available");
    expect(result.source).toBe("text");
  });

  it("vypredané (post-22111 onbackorder, JSON-LD BackOrder) → unavailable, source text", () => {
    const result = parsePage(VYPREDANE, VYPREDANE_URL);
    expect(result.availability).toBe("unavailable");
    expect(result.source).toBe("text");
  });

  it("visibleAvailabilityFor ukotví na post-<postid>, NIE na 8 súvisiacich instock produktov", () => {
    // Vypredaná stránka má 8 súvisiacich produktov s vlastnými post-<id> + „Na sklade".
    // Naivné „prvý instock" by vrátilo available — ukotvenie na post-22111 dáva unavailable.
    expect(visibleAvailabilityFor(VYPREDANE_URL, VYPREDANE)).toEqual({ availability: "unavailable", text: "onbackorder" });
    expect(visibleAvailabilityFor(SKLADOM_URL, SKLADOM)).toEqual({ availability: "available", text: "instock" });
  });

  it("vo.pyra.eu (poddoména) je pokryté rovnakým pravidlom (sufix match)", () => {
    expect(visibleAvailabilityFor("https://vo.pyra.eu/nejaky-produkt/", SKLADOM)?.availability).toBe("available");
  });
});

describe("parsePage — issue 559: pasce a fail-closed", () => {
  it("p.stock 'Na sklade' (10× zo súvisiacich) na VYPREDANEJ stránke sa NIKDY nečíta → unavailable", () => {
    // Syntetický mechanizmus (presne dizajnová pasca, produkt 666): hlavný produkt
    // onbackorder, ale 10× <p class="stock in-stock step-3">Na sklade</p> zo súvisiacich.
    const naSkladeNoise = '<p class="stock in-stock step-3">Na sklade</p>'.repeat(10);
    const html =
      '<html><head><script type="application/ld+json">' +
      '{"@type":"Product","offers":{"@type":"Offer","availability":"https://schema.org/BackOrder"}}' +
      "</script></head>" +
      '<body class="single single-product postid-666 woocommerce">' +
      '<div class="product type-product post-666 status-publish first onbackorder">hlavný</div>' +
      naSkladeNoise +
      "</body></html>";
    expect(parsePage(html, "https://pyra.eu/optika/test-666/").availability).toBe("unavailable");
  });

  it("rozpor token vs JSON-LD (post instock, JSON-LD BackOrder) → unknown", () => {
    const html =
      '<html><head><script type="application/ld+json">' +
      '{"@type":"Product","offers":{"@type":"Offer","availability":"https://schema.org/BackOrder"}}' +
      "</script></head>" +
      '<body class="single-product postid-777 woocommerce">' +
      '<div class="product type-product post-777 status-publish instock">x</div></body></html>';
    expect(parsePage(html, "https://pyra.eu/optika/test-777/").availability).toBe("unknown");
  });

  it("stránka bez postid / bez post-<id> prvku + JSON-LD InStock → unknown, NIKDY available (fail-closed)", () => {
    const html =
      '<html><head><script type="application/ld+json">' +
      '{"@type":"Product","offers":{"@type":"Offer","availability":"https://schema.org/InStock"}}' +
      "</script></head><body class=\"single-product woocommerce\">bez postid</body></html>";
    expect(parsePage(html, "https://pyra.eu/optika/test-nic/").availability).toBe("unknown");
  });
});
