import { describe, expect, it } from "vitest";
import { baseImageMime, isAllowedImageMime, SCAN_MAX_IMAGE_BYTES, SCAN_MIN_IMAGE_BYTES } from "./image.js";

// issue 543: čistá logika obrázkového skenu (bez DB) — samostatne testovateľná.
describe("uhrady/image", () => {
  it("baseImageMime oreže parameter a normalizuje na malé písmená", () => {
    expect(baseImageMime("image/jpeg")).toBe("image/jpeg");
    expect(baseImageMime("IMAGE/PNG")).toBe("image/png");
    expect(baseImageMime("image/jpeg; charset=binary")).toBe("image/jpeg");
  });

  it("isAllowedImageMime povolí len jpg/png", () => {
    expect(isAllowedImageMime("image/jpeg")).toBe(true);
    expect(isAllowedImageMime("image/png")).toBe(true);
    expect(isAllowedImageMime("image/png; foo=bar")).toBe(true);
    expect(isAllowedImageMime("image/webp")).toBe(false);
    expect(isAllowedImageMime("image/gif")).toBe(false);
    expect(isAllowedImageMime("application/pdf")).toBe(false);
    expect(isAllowedImageMime("text/html")).toBe(false);
  });

  it("stropy veľkosti sú rozumné a spodná < horná", () => {
    expect(SCAN_MIN_IMAGE_BYTES).toBeGreaterThan(0);
    expect(SCAN_MAX_IMAGE_BYTES).toBeGreaterThan(SCAN_MIN_IMAGE_BYTES);
  });
});
