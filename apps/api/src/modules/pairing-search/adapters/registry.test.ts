import { describe, expect, it } from "vitest";
import { adapterFor, adapterForUrl, SUPPLIER_ADAPTERS } from "./registry.js";

describe("SUPPLIER_ADAPTERS registry", () => {
  it("carries exactly the three E2 adapters keyed by their adapterKey", () => {
    expect(new Set(SUPPLIER_ADAPTERS.keys())).toEqual(new Set(["wetland", "betalov", "odimon"]));
  });

  it("adapterFor resolves a known key to the matching adapter", () => {
    expect(adapterFor("wetland")?.baseUrl).toBe("https://www.wetland.sk");
    expect(adapterFor("betalov")?.baseUrl).toBe("https://www.huntingshop.eu");
    expect(adapterFor("odimon")?.baseUrl).toBe("https://www.odimon.sk");
  });

  it("adapterFor returns undefined for an unknown key", () => {
    expect(adapterFor("neexistujuci-dodavatel")).toBeUndefined();
  });

  // issue 422 — host-based lookup (na rozdiel od `adapterFor`'s adapterKey lookup).
  it("adapterForUrl resolves a URL to the adapter whose baseUrl it belongs to", () => {
    expect(adapterForUrl("https://www.wetland.sk/nohavice/x-1")?.adapterKey).toBe("wetland");
    expect(adapterForUrl("https://www.huntingshop.eu/nohavice-1")?.adapterKey).toBe("betalov");
    expect(adapterForUrl("https://www.odimon.sk/obuv/x")?.adapterKey).toBe("odimon");
  });

  it("adapterForUrl returns undefined for a URL outside all three known suppliers", () => {
    expect(adapterForUrl("https://e2e-dodavatel.example.com/produkt")).toBeUndefined();
    expect(adapterForUrl("not a valid url")).toBeUndefined();
  });
});
