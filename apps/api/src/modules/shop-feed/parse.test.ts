import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseShopFeed } from "./parse.js";

const sample = readFileSync(
  fileURLToPath(new URL("./fixtures/feed-sample.xml", import.meta.url)),
  "utf8",
);

describe("parseShopFeed", () => {
  it("vráti dvojicu kód → adresa pre každú použiteľnú položku", () => {
    expect(parseShopFeed(sample)).toEqual([
      { code: "40237/M", url: "https://www.forestshop.sk/polovnicke-nohavice-forest-1003/?variantId=106" },
      { code: "15314", url: "https://www.forestshop.sk/polovnicky-ruksak-hart-spean-25/" },
      { code: "10125/41", url: "https://www.forestshop.sk/obuv/?variantId=9&utm=feed" },
    ]);
  });

  it("nepoužije hlavičkový <link href=…> feedu ako adresu produktu", () => {
    expect(parseShopFeed(sample).some((row) => row.url.includes("example.com"))).toBe(false);
  });

  it("z prázdneho vstupu vráti prázdny zoznam namiesto vyhodenia", () => {
    expect(parseShopFeed("")).toEqual([]);
  });
});
