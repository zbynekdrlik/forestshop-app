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
      {
        code: "40237/M",
        url: "https://www.forestshop.sk/polovnicke-nohavice-forest-1003/?variantId=106",
        availability: "in stock",
        imageUrl: "https://cdn.myshoptet.com/usr/www.forestshop.sk/user/shop/orig/nohavice-forest-1003.jpg",
      },
      {
        code: "15314",
        url: "https://www.forestshop.sk/polovnicky-ruksak-hart-spean-25/",
        availability: "out of stock",
        // <g:image_link></g:image_link> prázdna → null, nikdy prázdny reťazec.
        imageUrl: null,
      },
      {
        code: "10125/41",
        url: "https://www.forestshop.sk/obuv/?variantId=9&utm=feed",
        // issue 226: prázdne <g:availability></g:availability> → null, nikdy
        // prázdny reťazec — chýbajúci signál sa nesmie dať zameniť s
        // hodnotou, ktorá by sa dala porovnávať proti "in stock"/"out of stock".
        availability: null,
        // issue 347: chýbajúca značka <g:image_link> úplne (nie len prázdna) → null.
        imageUrl: null,
      },
    ]);
  });

  // issue 347: obrázok produktu — appka ho potrebuje pre kartu v e-maile
  // "alternatívy k nedostupnému tovaru".
  it("vyparsuje <g:image_link> ku každej položke", () => {
    const rows = parseShopFeed(sample);
    expect(rows.find((r) => r.code === "40237/M")?.imageUrl).toBe(
      "https://cdn.myshoptet.com/usr/www.forestshop.sk/user/shop/orig/nohavice-forest-1003.jpg",
    );
    expect(rows.find((r) => r.code === "15314")?.imageUrl).toBeNull();
  });

  // issue 226: krížová kontrola nášho stavu proti feedu potrebuje aj
  // Shoptetovu VLASTNÚ dostupnosť, nie len kód/adresu.
  it("vyparsuje <g:availability> ku každej položke", () => {
    const rows = parseShopFeed(sample);
    expect(rows.find((r) => r.code === "40237/M")?.availability).toBe("in stock");
    expect(rows.find((r) => r.code === "15314")?.availability).toBe("out of stock");
  });

  it("položka bez <g:availability> vôbec (chýbajúca značka) dostane null", () => {
    // "99999" v fixtúre má <g:availability>in stock</g:availability> ale bez
    // <link> — preskočí sa celá. Preto pre tento prípad vlastný vstup.
    const xml = "<feed><entry><g:id>ABC</g:id><link>https://x.sk/p/</link></entry></feed>";
    expect(parseShopFeed(xml)).toEqual([{ code: "ABC", url: "https://x.sk/p/", availability: null, imageUrl: null }]);
  });

  it("nepoužije hlavičkový <link href=…> feedu ako adresu produktu", () => {
    expect(parseShopFeed(sample).some((row) => row.url.includes("example.com"))).toBe(false);
  });

  it("z prázdneho vstupu vráti prázdny zoznam namiesto vyhodenia", () => {
    expect(parseShopFeed("")).toEqual([]);
  });
});
