import { describe, expect, it } from "vitest";
import { toPairingProduct } from "./types.js";

describe("toPairingProduct", () => {
  it("collects distinct, non-empty external codes across all variants, in first-seen order", () => {
    const p = toPairingProduct(
      { key: "guid-1", name: "Nohavice HART RANDO XHP", supplier: "BETALOV" },
      [{ externalCode: "60177/46" }, { externalCode: "60177/48" }, { externalCode: "60177/46" }],
    );
    expect(p.productKey).toBe("guid-1");
    expect(p.name).toBe("Nohavice HART RANDO XHP");
    expect(p.supplier).toBe("BETALOV");
    expect(p.externalCodes).toEqual(["60177/46", "60177/48"]);
  });

  it("drops null/empty/whitespace-only external codes", () => {
    const p = toPairingProduct({ key: "guid-2", name: "Bunda FOREST", supplier: null }, [
      { externalCode: null },
      { externalCode: "" },
      { externalCode: "   " },
      { externalCode: "OB570" },
    ]);
    expect(p.externalCodes).toEqual(["OB570"]);
    expect(p.supplier).toBeNull();
  });

  it("returns an empty externalCodes list for a product with no variants", () => {
    const p = toPairingProduct({ key: "guid-3", name: "X", supplier: null }, []);
    expect(p.externalCodes).toEqual([]);
  });

  it("trims whitespace around an otherwise valid external code", () => {
    const p = toPairingProduct({ key: "guid-4", name: "X", supplier: "ODIMON" }, [{ externalCode: "  ZZ9  " }]);
    expect(p.externalCodes).toEqual(["ZZ9"]);
  });
});
