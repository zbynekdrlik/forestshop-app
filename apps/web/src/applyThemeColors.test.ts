import { afterEach, expect, it } from "vitest";
import { applyThemeColors } from "./applyThemeColors.js";

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

it("zapíše každý kľúč ako CSS premennú s `--` prefixom na document.documentElement", () => {
  applyThemeColors({ "chip-done-bg": "#123456", "chip-done-text": "#ffffff" });
  expect(document.documentElement.style.getPropertyValue("--chip-done-bg")).toBe("#123456");
  expect(document.documentElement.style.getPropertyValue("--chip-done-text")).toBe("#ffffff");
});

it("prázdny objekt nezapíše žiadnu CSS premennú a nespadne", () => {
  expect(() => {
    applyThemeColors({});
  }).not.toThrow();
  expect(document.documentElement.getAttribute("style")).toBeFalsy();
});
