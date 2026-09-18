// grube.de / grube.sk (rovnaký e-shop, vlastná platforma Grube) — issue 557 (podticket #555).
// Dostupnosť je v JSON-LD `Product.offers` — jeden `Offer` alebo `AggregateOffer.offers[]`.
// Per ponuka: veľkosť = token „Größe X" z `name`, available = availability InStock A
// inventoryLevel.value >= 1; BackOrder/SoldOut = unavailable. Bez „Größe" tokenu (jeden
// Offer) → plošný riadok (VISIBLE cesta z toho istého JSON-LD). Text „auf Lager" je
// šablónový šum — nikdy sa nečíta. Vlastný súbor (eslint max-lines 400).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { visibleAvailabilityFor } from "./availability-domain-rules.js";
import { parsePage, parseSizeAvailability, type SizeAvailability } from "./parse.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const SOFTSHELL = fixture("grube-de-softshelljacke-594088.html");
const COMPANION = fixture("grube-sk-companion-nuz-549057.html");

const SOFTSHELL_URL = "https://www.grube.de/p/percussion-softshelljacke/594088/";
const COMPANION_URL = "https://www.grube.sk/p/noz-companion-f-heavy-duty/549057/?q=morakiv#itemId=5490575057";

const sortBySize = (list: readonly SizeAvailability[] | null): readonly SizeAvailability[] =>
  [...(list ?? [])].sort((a, b) => a.sizeLabel.localeCompare(b.sizeLabel));

// Inline JSON-LD s AggregateOffer (syntetické edge-case testy — dedup, inv0).
const grubeAggregate = (offers: readonly Record<string, unknown>[]): string =>
  `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org/",
    "@type": "Product",
    name: "Test",
    offers: { "@type": "AggregateOffer", offers },
  })}</script></head><body>auf Lager auf Lager</body></html>`;
const offer = (name: string | null, avail: string, inv: number): Record<string, unknown> => ({
  "@type": "Offer",
  ...(name === null ? {} : { name }),
  availability: `https://schema.org/${avail}`,
  inventoryLevel: { "@type": "QuantitativeValue", value: inv },
});

describe("parseSizeAvailability — issue 557: grube AggregateOffer per veľkosť (Größe token)", () => {
  it("softshelljacke (grün-orange) → S/M/L/XL/XXL/4XL available, 3XL (BackOrder) unavailable", () => {
    expect(sortBySize(parseSizeAvailability(SOFTSHELL, SOFTSHELL_URL))).toEqual([
      { sizeLabel: "3XL", availability: "unavailable" },
      { sizeLabel: "4XL", availability: "available" },
      { sizeLabel: "L", availability: "available" },
      { sizeLabel: "M", availability: "available" },
      { sizeLabel: "S", availability: "available" },
      { sizeLabel: "XL", availability: "available" },
      { sizeLabel: "XXL", availability: "available" },
    ]);
  });

  it("jeden Offer bez 'Größe' tokenu (companion nôž) → null (padne na blanket cez parsePage)", () => {
    expect(parseSizeAvailability(COMPANION, COMPANION_URL)).toBeNull();
  });

  it("InStock ale inventoryLevel 0 → unavailable (available VYŽADUJE inv >= 1)", () => {
    const html = grubeAggregate([offer("Farbe khaki. Größe M.", "InStock", 0)]);
    expect(parseSizeAvailability(html, SOFTSHELL_URL)).toEqual([{ sizeLabel: "M", availability: "unavailable" }]);
  });

  it("tá istá veľkosť v dvoch farbách, OBE InStock → jedna položka (dedup)", () => {
    const html = grubeAggregate([
      offer("Farbe khaki. Größe L.", "InStock", 5),
      offer("Farbe grün. Größe L.", "InStock", 3),
    ]);
    expect(parseSizeAvailability(html, SOFTSHELL_URL)).toEqual([{ sizeLabel: "L", availability: "available" }]);
  });

  it("tá istá veľkosť v dvoch farbách, ROZPOR (InStock vs SoldOut) → veľkosť sa ZAHODÍ (fail-closed)", () => {
    const html = grubeAggregate([
      offer("Farbe khaki. Größe L.", "InStock", 5),
      offer("Farbe grün. Größe L.", "SoldOut", 0),
    ]);
    expect(parseSizeAvailability(html, SOFTSHELL_URL)).toBeNull();
  });

  it("iná doména (bez grube pravidla) → null", () => {
    expect(parseSizeAvailability(SOFTSHELL, "https://www.huntingshop.eu/p/1")).toBeNull();
  });

  it("code review 🔵: číta sa LEN prvý (hlavný) Product uzol — súvisiaci produkt neinjektuje cudzie veľkosti", () => {
    // Dva Product uzly: hlavný (Größe M available) + súvisiaci NIŽŠIE (Größe M SoldOut).
    // Bez ukotvenia na prvý Product by sa obe M videli → rozpor → M by sa zahodila.
    // S ukotvením sa číta len hlavný → M available.
    const mainProduct = { "@context": "https://schema.org/", "@type": "Product", name: "Hlavný",
      offers: { "@type": "AggregateOffer", offers: [offer("Farbe khaki. Größe M.", "InStock", 5)] } };
    const relatedProduct = { "@context": "https://schema.org/", "@type": "Product", name: "Súvisiaci",
      offers: { "@type": "AggregateOffer", offers: [offer("Farbe grün. Größe M.", "SoldOut", 0)] } };
    const html =
      `<html><head><script type="application/ld+json">${JSON.stringify(mainProduct)}</script></head>` +
      `<body><script type="application/ld+json">${JSON.stringify(relatedProduct)}</script></body></html>`;
    expect(parseSizeAvailability(html, SOFTSHELL_URL)).toEqual([{ sizeLabel: "M", availability: "available" }]);
  });
});

describe("parsePage / visibleAvailabilityFor — issue 557: grube blanket (jeden Offer bez Größe)", () => {
  it("companion nôž (jeden Offer InStock inv 10) → available, source text (blanket VISIBLE cesta)", () => {
    const result = parsePage(COMPANION, COMPANION_URL);
    expect(result.availability).toBe("available");
    expect(result.source).toBe("text");
  });

  it("visibleAvailabilityFor(companion) → available (jeden Offer)", () => {
    expect(visibleAvailabilityFor(COMPANION_URL, COMPANION)?.availability).toBe("available");
  });

  it("grube.de aj grube.sk sú overené domény (blanket cesta nedôveruje JSON-LD naslepo)", () => {
    // Viac ponúk (aggregate) na blanket ceste → unknown (fail-closed), nikdy prvá ponuka ako dohad.
    expect(visibleAvailabilityFor(SOFTSHELL_URL, SOFTSHELL)?.availability).toBe("unknown");
  });
});
