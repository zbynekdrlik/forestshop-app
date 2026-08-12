import { describe, expect, it } from "vitest";
import { adapterFor, SUPPLIER_ADAPTERS } from "./registry.js";

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
});
