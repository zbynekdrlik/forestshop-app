// issue 402: `runShopSitemap` naživo proti reálnej DB — sitemap prechod,
// probe prechod, časový rozpočet, a NIKDY neprepíše feedom potvrdený riadok.

import { asc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { products, shopProductUrl, variants } from "../src/db/schema.js";
import { MIN_SITEMAP_LOCS } from "../src/modules/shop-sitemap/constants.js";
import { runShopSitemap } from "../src/modules/shop-sitemap/run.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";

const NOW = new Date("2026-08-13T04:05:00Z");

function sitemapWith(slugs: readonly string[]): string {
  const entries = slugs.map((s) => `<url><loc>https://www.forestshop.sk/${s}/</loc></url>`).join("");
  // MIN_SITEMAP_LOCS je 500 — vypĺň zvyšok bezvýznamnými, ale platnými položkami.
  const filler = Array.from({ length: MIN_SITEMAP_LOCS }, (_unused, i) => `<url><loc>https://www.forestshop.sk/filler-${String(i)}/</loc></url>`).join("");
  return `<urlset>${entries}${filler}</urlset>`;
}

describe("runShopSitemap", () => {
  let db: Database;
  let close: () => Promise<void>;
  let snapshotId: string;

  beforeEach(async () => {
    ({ db, close } = await withCleanDb());
    snapshotId = await insertTestSnapshot(db);
  });
  afterEach(async () => {
    await close();
  });

  const seedProduct = async (key: string, name: string): Promise<void> => {
    await db.insert(products).values({ key, name, supplier: null, internalNote: null, firstSeenAt: NOW, lastSeenAt: NOW, lastSeenSnapshotId: snapshotId });
  };
  const seedVariant = async (code: string, productKey: string): Promise<void> => {
    await db.insert(variants).values({
      code,
      productKey,
      guid: productKey,
      sizeLabel: null,
      name: `Variant ${code}`,
      stock: 0,
      availabilityInStockText: "",
      availabilityOutOfStockText: "",
      availabilityText: "",
      productVisibility: "visible",
      state: "sellable",
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      lastSeenSnapshotId: snapshotId,
    });
  };

  it("žiadny chýbajúci produkt → no-op, sitemapa sa vôbec NESTIAHNE", async () => {
    let fetchCalled = false;
    const result = await runShopSitemap({
      db,
      now: NOW,
      fetchSitemap: () => {
        fetchCalled = true;
        return Promise.resolve(sitemapWith([]));
      },
      fetchCandidate: () => Promise.resolve(null),
    });
    expect(result).toEqual({ missingProducts: 0, resolvedBySitemap: 0, resolvedByProbe: 0, codesAttempted: 0, totalStored: 0, stoppedEarly: false });
    expect(fetchCalled).toBe(false);
  });

  it("sitemap prechod vyrieši produkt a zapíše VŠETKY jeho chýbajúce kódy s source='sitemap'", async () => {
    await seedProduct("p-a", "Bunda Forest");
    await seedVariant("A1", "p-a");
    await seedVariant("A2", "p-a");

    const result = await runShopSitemap({
      db,
      now: NOW,
      fetchSitemap: () => Promise.resolve(sitemapWith(["bunda-forest"])),
      fetchCandidate: () => Promise.resolve(null),
    });

    expect(result.resolvedBySitemap).toBe(1);
    expect(result.resolvedByProbe).toBe(0);
    expect(result.codesAttempted).toBe(2);

    const rows = await db
      .select({ code: shopProductUrl.code, url: shopProductUrl.url, source: shopProductUrl.source })
      .from(shopProductUrl)
      .where(inArray(shopProductUrl.code, ["A1", "A2"]))
      .orderBy(asc(shopProductUrl.code));
    expect(rows).toEqual([
      { code: "A1", url: "https://www.forestshop.sk/bunda-forest/", source: "sitemap" },
      { code: "A2", url: "https://www.forestshop.sk/bunda-forest/", source: "sitemap" },
    ]);
  });

  it("produkt NEVYRIEŠENÝ sitemapou padá na probe prechod, zapíše sa so source='probe'", async () => {
    await seedProduct("p-b", "Neexistujuci Produkt V Sitemape");
    await seedVariant("B1", "p-b");

    const result = await runShopSitemap({
      db,
      now: NOW,
      fetchSitemap: () => Promise.resolve(sitemapWith([])), // sitemapa produkt nemá
      fetchCandidate: (c) => Promise.resolve(c === "neexistujuci-produkt-v-sitemape" ? "https://www.forestshop.sk/neexistujuci-produkt-v-sitemape/" : null),
    });

    expect(result.resolvedBySitemap).toBe(0);
    expect(result.resolvedByProbe).toBe(1);

    const [row] = await db.select({ url: shopProductUrl.url, source: shopProductUrl.source }).from(shopProductUrl).where(eq(shopProductUrl.code, "B1"));
    expect(row).toEqual({ url: "https://www.forestshop.sk/neexistujuci-produkt-v-sitemape/", source: "probe" });
  });

  it("NIKDY neprepíše riadok potvrdený feedom — produkt s ČIASTOČNÝM pokrytím dostane len chýbajúci kód, feedový ostáva nedotknutý", async () => {
    await seedProduct("p-c", "Ciastocny Produkt");
    await seedVariant("C1", "p-c");
    await seedVariant("C2", "p-c");
    await db.insert(shopProductUrl).values({ code: "C1", url: "https://www.forestshop.sk/povodna-feed-url/?variantId=9", fetchedAt: NOW, source: "feed" });

    await runShopSitemap({
      db,
      now: NOW,
      fetchSitemap: () => Promise.resolve(sitemapWith(["ciastocny-produkt"])),
      fetchCandidate: () => Promise.resolve(null),
    });

    const rows = await db
      .select({ code: shopProductUrl.code, url: shopProductUrl.url, source: shopProductUrl.source })
      .from(shopProductUrl)
      .where(inArray(shopProductUrl.code, ["C1", "C2"]))
      .orderBy(asc(shopProductUrl.code));
    // C1 (feed) je BEZO ZMENY, C2 dostal novú sitemap URL.
    expect(rows).toEqual([
      { code: "C1", url: "https://www.forestshop.sk/povodna-feed-url/?variantId=9", source: "feed" },
      { code: "C2", url: "https://www.forestshop.sk/ciastocny-produkt/", source: "sitemap" },
    ]);
  });

  it("príliš malá/pokazená sitemapa vyhodí a NIČ nezapíše (poistka pred zápisom)", async () => {
    await seedProduct("p-d", "Produkt D");
    await seedVariant("D1", "p-d");

    await expect(
      runShopSitemap({ db, now: NOW, fetchSitemap: () => Promise.resolve("<urlset></urlset>"), fetchCandidate: () => Promise.resolve(null) }),
    ).rejects.toThrow(/beh sa zastavuje bez zápisu/);

    const [row] = await db.select({ code: shopProductUrl.code }).from(shopProductUrl).where(eq(shopProductUrl.code, "D1"));
    expect(row).toBeUndefined();
  });

  it("časový rozpočet zastaví probe prechod PO aktuálnom produkte — zvyšok ostáva bez riadku pre ĎALŠÍ beh", async () => {
    await seedProduct("p-e", "Prvy Produkt");
    await seedVariant("E1", "p-e");
    await seedProduct("p-f", "Druhy Produkt");
    await seedVariant("F1", "p-f");

    // clock() sa volá: 1× pre deadline, potom PRED KAŽDÝM produktom v
    // remainder-i (rovnaký vzor ako `pairing-search/run.test.ts`).
    const clockValues = [0, 0, 1000]; // deadline=0+1=1; item0 check 0<1 pokračuje; item1 check 1000>=1 zastaví
    let callIndex = 0;
    const clock = () => {
      const v = clockValues[callIndex] ?? 1000;
      callIndex += 1;
      return v;
    };

    const result = await runShopSitemap({
      db,
      now: NOW,
      fetchSitemap: () => Promise.resolve(sitemapWith([])),
      fetchCandidate: () => Promise.resolve(null), // žiadny kandidát sa nikdy nepotvrdí — obaja produkti by aj tak zostali null
      clock,
      timeBudgetMs: 1,
    });

    expect(result.stoppedEarly).toBe(true);
    expect(result.resolvedByProbe).toBe(0);
    expect(result.missingProducts).toBe(2);

    const rows = await db.select({ code: shopProductUrl.code }).from(shopProductUrl).where(inArray(shopProductUrl.code, ["E1", "F1"]));
    expect(rows).toEqual([]);
  });
});
