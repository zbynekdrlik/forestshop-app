import { describe, expect, it } from "vitest";
import { parseBackfillFromArg } from "./backfill-open-args.js";

describe("parseBackfillFromArg (issue 595)", () => {
  it("--from YYYY-MM-DD → polnoc UTC toho dňa", () => {
    expect(parseBackfillFromArg(["--from", "2025-01-01"]).toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });

  it("chýbajúci --from alebo hodnota → chyba s návodom", () => {
    expect(() => parseBackfillFromArg([])).toThrow("--from YYYY-MM-DD");
    expect(() => parseBackfillFromArg(["--from"])).toThrow("--from YYYY-MM-DD");
  });

  it("zlý tvar dátumu → chyba", () => {
    expect(() => parseBackfillFromArg(["--from", "2025-1-1"])).toThrow("Chýba alebo je chybný --from");
    expect(() => parseBackfillFromArg(["--from", "1.1.2025"])).toThrow("Chýba alebo je chybný --from");
  });

  it("neexistujúci deň (30. február) → chyba, nie ticho posunutý dátum", () => {
    expect(() => parseBackfillFromArg(["--from", "2025-02-30"])).toThrow("Neplatný dátum v --from: 2025-02-30");
  });
});
