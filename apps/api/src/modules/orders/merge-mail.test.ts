import { describe, expect, it } from "vitest";
import { formatOrderNumbers } from "./merge-mail.js";

// issue 257: čisto textové formátovanie ("č. X a č. Y" — plynulá veta pre
// `{{zoznam_objednavok}}`, viď `mail-templates/registry.ts`'s komentár prečo
// je toto pole OBYČAJNÝ text, nie `list`). Žiadna DB potrebná — patrí do
// `src/**/*.test.ts` (`.claude/rules/testing.md`'s dve úrovne testov).
describe("formatOrderNumbers", () => {
  it("jedno číslo — bez spojky", () => {
    expect(formatOrderNumbers(["20260123"])).toBe("č. 20260123");
  });

  it("dve čísla — spojené 'a'", () => {
    expect(formatOrderNumbers(["20260123", "20260124"])).toBe("č. 20260123 a č. 20260124");
  });

  it("tri a viac čísel — čiarky, posledné spojené 'a'", () => {
    expect(formatOrderNumbers(["20260123", "20260124", "20260125"])).toBe("č. 20260123, č. 20260124 a č. 20260125");
  });

  it("prázdny zoznam — prázdny reťazec (obranná vetva, appka ho nikdy takto nevolá)", () => {
    expect(formatOrderNumbers([])).toBe("");
  });
});
