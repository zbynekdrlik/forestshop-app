// issue 402: `selectMissingProducts`/`selectExistingSitemapProbeUrls` naživo
// proti reálnej DB.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { products, shopProductUrl, variants } from "../src/db/schema.js";
import { selectExistingSitemapProbeUrls, selectMissingProducts } from "../src/modules/shop-sitemap/select.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";

const NOW = new Date("2026-08-13T04:05:00Z");

describe("selectMissingProducts / selectExistingSitemapProbeUrls", () => {
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

  it("produkt so VŠETKÝMI kódmi vo feede sa NEZOBRAZÍ v populácii", async () => {
    await seedProduct("p-a", "Produkt A");
    await seedVariant("A1", "p-a");
    await db.insert(shopProductUrl).values({ code: "A1", url: "https://www.forestshop.sk/produkt-a/?variantId=1", fetchedAt: NOW, source: "feed" });

    expect(await selectMissingProducts(db)).toEqual([]);
  });

  it("produkt bez ŽIADNEHO shop_product_url riadku sa zobrazí, so VŠETKÝMI kódmi ako chýbajúcimi", async () => {
    await seedProduct("p-b", "Produkt B");
    await seedVariant("B1", "p-b");
    await seedVariant("B2", "p-b");

    const result = await selectMissingProducts(db);
    expect(result).toEqual([{ productKey: "p-b", name: "Produkt B", missingCodes: ["B1", "B2"] }]);
  });

  it("produkt s ČIASTOČNÝM pokrytím (jeden kód vo feede, druhý nie) sa zobrazí LEN s chýbajúcim kódom", async () => {
    await seedProduct("p-c", "Produkt C");
    await seedVariant("C1", "p-c");
    await seedVariant("C2", "p-c");
    await db.insert(shopProductUrl).values({ code: "C1", url: "https://www.forestshop.sk/produkt-c/?variantId=1", fetchedAt: NOW, source: "feed" });

    const result = await selectMissingProducts(db);
    expect(result).toEqual([{ productKey: "p-c", name: "Produkt C", missingCodes: ["C2"] }]);
  });

  it("kód už vyriešený PREDOŠLÝM sitemap/probe behom sa NEOPAKUJE (source != feed sa stále počíta ako 'má riadok')", async () => {
    await seedProduct("p-d", "Produkt D");
    await seedVariant("D1", "p-d");
    await db.insert(shopProductUrl).values({ code: "D1", url: "https://www.forestshop.sk/produkt-d/", fetchedAt: NOW, source: "sitemap" });

    expect(await selectMissingProducts(db)).toEqual([]);
  });

  it("selectExistingSitemapProbeUrls vráti LEN sitemap/probe riadky, nikdy feed", async () => {
    await seedProduct("p-e", "Produkt E");
    await seedVariant("E1", "p-e");
    await db.insert(shopProductUrl).values({ code: "E1", url: "https://www.forestshop.sk/produkt-e/?variantId=1", fetchedAt: NOW, source: "feed" });

    await seedProduct("p-f", "Produkt F");
    await seedVariant("F1", "p-f");
    await db.insert(shopProductUrl).values({ code: "F1", url: "https://www.forestshop.sk/produkt-f/", fetchedAt: NOW, source: "sitemap" });

    const result = await selectExistingSitemapProbeUrls(db);
    expect(result).toEqual([{ url: "https://www.forestshop.sk/produkt-f/", nameSlug: "produkt-f" }]);
  });

  it("selectExistingSitemapProbeUrls dedupuje viac kódov TOHO ISTÉHO produktu na jednu URL", async () => {
    await seedProduct("p-g", "Produkt G");
    await seedVariant("G1", "p-g");
    await seedVariant("G2", "p-g");
    await db.insert(shopProductUrl).values([
      { code: "G1", url: "https://www.forestshop.sk/produkt-g/", fetchedAt: NOW, source: "sitemap" },
      { code: "G2", url: "https://www.forestshop.sk/produkt-g/", fetchedAt: NOW, source: "sitemap" },
    ]);

    const result = await selectExistingSitemapProbeUrls(db);
    expect(result).toEqual([{ url: "https://www.forestshop.sk/produkt-g/", nameSlug: "produkt-g" }]);
  });
});
