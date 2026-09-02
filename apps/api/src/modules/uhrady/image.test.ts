import { describe, expect, it } from "vitest";
import { baseImageMime, isAllowedImageMime, looksLikeJpegOrPng, SCAN_MAX_IMAGE_BYTES, SCAN_MIN_IMAGE_BYTES } from "./image.js";

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

  it("looksLikeJpegOrPng príjme PNG aj JPEG signatúru, odmietne iné/krátke", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x11]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(looksLikeJpegOrPng(png)).toBe(true);
    expect(looksLikeJpegOrPng(jpeg)).toBe(true);
    // HTML ("<!DOCTYPE") podvrhnuté ako obrázok.
    expect(looksLikeJpegOrPng(Buffer.from("<!DOCTYPE html>", "utf8"))).toBe(false);
    // Vyplnené nezmyselné bajty (ako starý testovací fixture) — odmietnuté.
    expect(looksLikeJpegOrPng(Buffer.alloc(64, 9))).toBe(false);
    // Príliš krátke na signatúru.
    expect(looksLikeJpegOrPng(Buffer.from([0xff, 0xd8]))).toBe(false);
  });
});
