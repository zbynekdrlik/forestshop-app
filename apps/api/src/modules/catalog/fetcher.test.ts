import { describe, expect, it } from "vitest";
import { redactUrl } from "./fetcher.js";

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
