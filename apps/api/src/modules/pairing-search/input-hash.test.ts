import { describe, expect, it } from "vitest";
import { computeInputHash } from "./input-hash.js";
import type { PairingProduct } from "./types.js";

function product(overrides: Partial<PairingProduct> = {}): PairingProduct {
  return {
    productKey: "p1",
    name: "Bunda Wetland",
    supplier: "WETLAND",
    externalCodes: [],
    ...overrides,
  };
}

describe("computeInputHash", () => {
  it("je deterministický pre rovnaký vstup", () => {
    expect(computeInputHash(product())).toBe(computeInputHash(product()));
  });

  it("mení sa pri zmene mena", () => {
    expect(computeInputHash(product({ name: "Bunda Wetland" }))).not.toBe(
      computeInputHash(product({ name: "Iné meno" })),
    );
  });

  it("mení sa pri zmene external kódov", () => {
    expect(computeInputHash(product({ externalCodes: ["A1"] }))).not.toBe(
      computeInputHash(product({ externalCodes: ["A1", "B2"] })),
    );
  });

  it("NEZÁVISÍ od poradia external kódov (zoraďuje sa pred hashovaním)", () => {
    expect(computeInputHash(product({ externalCodes: ["A1", "B2"] }))).toBe(
      computeInputHash(product({ externalCodes: ["B2", "A1"] })),
    );
  });

  it("NEZÁVISÍ od productKey/supplier — len meno + kódy určujú zastaranie", () => {
    expect(computeInputHash(product({ productKey: "p1", supplier: "WETLAND" }))).toBe(
      computeInputHash(product({ productKey: "p2", supplier: "ODIMON" })),
    );
  });
});
