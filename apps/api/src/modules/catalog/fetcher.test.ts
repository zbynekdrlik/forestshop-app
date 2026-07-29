import { describe, expect, it } from "vitest";
import { redactSourceLabel, redactUrl } from "./fetcher.js";

describe("redactUrl", () => {
  it("prekryje prihlasovací hash, ostatné parametre nechá", () => {
    expect(
      redactUrl("https://www.forestshop.sk/export/products.csv?patternId=14&partnerId=3&hash=tajne123"),
    ).toBe("https://www.forestshop.sk/export/products.csv?patternId=14&partnerId=3&hash=***");
  });

  it("prekryje hash bez ohľadu na veľkosť písmen v názve parametra", () => {
    expect(redactUrl("https://e.sk/x.csv?HASH=tajne")).toBe("https://e.sk/x.csv?HASH=***");
  });

  it("URL bez hashu nechá nezmenenú", () => {
    expect(redactUrl("https://e.sk/x.csv?a=1")).toBe("https://e.sk/x.csv?a=1");
  });
});

// Minor (review task-5-fix-1): služba (ingest.ts) dôveruje `sourceLabel` od
// AKÉHOKOĽVEK vstreknutého fetchera — vlastnoručne napísaný fetcher (test,
// alebo budúci alternatívny zdroj) by mohol vrátiť surovú URL s `hash` priamo.
// `redactSourceLabel` je bezpečná obálka nad `redactUrl` pre volanie zo
// samotnej služby, nie len z `createHttpExportFetcher`.
describe("redactSourceLabel", () => {
  it("prekryje hash, keď je sourceLabel skutočná URL, ktorú fetcher neprekryl", () => {
    expect(redactSourceLabel("https://www.forestshop.sk/export/products.csv?hash=tajne123")).toBe(
      "https://www.forestshop.sk/export/products.csv?hash=***",
    );
  });

  it("nie-URL popisok (napr. z testu alebo budúceho iného zdroja) nechá nezmenený, nevyhodí výnimku", () => {
    expect(redactSourceLabel("fixtúra")).toBe("fixtúra");
  });

  it("už prekrytú URL (od createHttpExportFetcher) nechá nezmenenú — je idempotentná", () => {
    const already = redactUrl("https://e.sk/x.csv?hash=povodne");
    expect(redactSourceLabel(already)).toBe(already);
  });
});
