import { describe, expect, it } from "vitest";
import { parseSitemapSlugs } from "./sitemap-fetcher.js";

function sitemapWith(paths: readonly string[]): string {
  const entries = paths.map((p) => `<url><loc>https://www.forestshop.sk/${p}/</loc><priority>0.8</priority></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset>${entries}</urlset>`;
}

describe("parseSitemapSlugs", () => {
  it("vytiahne slug (cesta bez domény, bez lomiek) z <loc> značiek", () => {
    expect(parseSitemapSlugs(sitemapWith(["moor-padded-waistcoat-367", "bunda-forest-zelena"]))).toEqual([
      "moor-padded-waistcoat-367",
      "bunda-forest-zelena",
    ]);
  });

  it("prázdna sitemapa vráti prázdne pole, nikdy nespadne", () => {
    expect(parseSitemapSlugs("<urlset></urlset>")).toEqual([]);
  });

  it("IGNORUJE <image:loc> (obrázkové URL, cdn.myshoptet.com) — reálna sitemapa ich nesie popri <loc>", () => {
    const xml =
      `<url><loc>https://www.forestshop.sk/produkt-a/</loc>` +
      `<image:image><image:loc>https://cdn.myshoptet.com/usr/www.forestshop.sk/user/shop/big/x.jpg</image:loc></image:image>` +
      `</url>`;
    expect(parseSitemapSlugs(xml)).toEqual(["produkt-a"]);
  });

  it("IGNORUJE riadok mimo forestshop.sk (obrana pri cudzom/pomýlenom <loc>)", () => {
    const xml = `<url><loc>https://iny-web.sk/produkt/</loc></url><url><loc>https://www.forestshop.sk/produkt-a/</loc></url>`;
    expect(parseSitemapSlugs(xml)).toEqual(["produkt-a"]);
  });

  it("IGNORUJE nesprávne tvarovanú <loc> hodnotu (nie je platné URL) bez pádu celej sitemapy", () => {
    const xml = `<url><loc>not a url [</loc></url><url><loc>https://www.forestshop.sk/produkt-a/</loc></url>`;
    expect(parseSitemapSlugs(xml)).toEqual(["produkt-a"]);
  });

  it("holá koreňová adresa (bez cesty) sa preskočí", () => {
    const xml = `<url><loc>https://www.forestshop.sk/</loc></url><url><loc>https://www.forestshop.sk/produkt-a/</loc></url>`;
    expect(parseSitemapSlugs(xml)).toEqual(["produkt-a"]);
  });
});
