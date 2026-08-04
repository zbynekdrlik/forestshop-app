// issue 226: `findFeedStateConflicts` naživo porovná AKTUÁLNY `variant.state`
// proti Shoptetovej vlastnej dostupnosti z feedu (`shop_product_url.availability`).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { products, shopProductUrl, variants } from "../src/db/schema.js";
import { findFeedStateConflicts } from "../src/modules/catalog/feed-cross-check.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";

const NOW = new Date("2026-08-04T10:00:00Z");

describe("findFeedStateConflicts", () => {
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

  const seedVariant = async (
    code: string,
    state: "sellable" | "out_of_stock" | "discontinued",
  ): Promise<void> => {
    const productKey = `prod-${code}`;
    await db
      .insert(products)
      .values({
        key: productKey,
        name: `Produkt ${code}`,
        supplier: null,
        internalNote: null,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        lastSeenSnapshotId: snapshotId,
      })
      .onConflictDoNothing();
    await db.insert(variants).values({
      code,
      productKey,
      guid: productKey,
      sizeLabel: null,
      name: `Produkt ${code}`,
      stock: 0,
      availabilityInStockText: "",
      availabilityOutOfStockText: "",
      availabilityText: "",
      productVisibility: "visible",
      state,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      lastSeenSnapshotId: snapshotId,
    });
  };

  const seedFeed = async (code: string, availability: string | null): Promise<void> => {
    await db.insert(shopProductUrl).values({
      code,
      url: `https://www.forestshop.sk/${code}/`,
      availability,
      fetchedAt: NOW,
    });
  };

  it("nevráti nič, keď naša strana sedí s feedom", async () => {
    await seedVariant("A1", "sellable");
    await seedFeed("A1", "in stock");
    await seedVariant("A2", "out_of_stock");
    await seedFeed("A2", "out of stock");

    const result = await findFeedStateConflicts(db);
    expect(result).toEqual({ total: 0, rows: [] });
  });

  // Práve TOTO je nebezpečný smer, ktorý issue 219 spôsobilo — naše
  // odvodenie vraví "vypredané", ale live feed hovorí "skladom".
  it("nájde variant, kde naše vypredané odporuje feedovému 'skladom'", async () => {
    await seedVariant("B1", "out_of_stock");
    await seedFeed("B1", "in stock");

    const result = await findFeedStateConflicts(db);
    expect(result.total).toBe(1);
    expect(result.rows).toEqual([
      { variantCode: "B1", productName: "Produkt B1", ourState: "out_of_stock", feedAvailability: "in stock", ourUrl: "https://www.forestshop.sk/B1/" },
    ]);
  });

  it("nájde aj opačný smer — naše sellable, feed hovorí vypredané", async () => {
    await seedVariant("C1", "sellable");
    await seedFeed("C1", "out of stock");

    const result = await findFeedStateConflicts(db);
    expect(result.rows.map((r) => r.variantCode)).toEqual(["C1"]);
  });

  it("variant mimo feedu (626-typ z issue 220) sa nepočíta ako rozpor", async () => {
    await seedVariant("D1", "out_of_stock");
    // Žiadny shopProductUrl riadok pre D1.

    const result = await findFeedStateConflicts(db);
    expect(result.total).toBe(0);
  });

  it("prázdne <g:availability> (null) sa nepočíta ako rozpor", async () => {
    await seedVariant("E1", "out_of_stock");
    await seedFeed("E1", null);

    const result = await findFeedStateConflicts(db);
    expect(result.total).toBe(0);
  });

  it("discontinued sa berie ako 'nekúpiteľné' rovnako ako out_of_stock proti feedu", async () => {
    await seedVariant("F1", "discontinued");
    await seedFeed("F1", "out of stock");

    expect((await findFeedStateConflicts(db)).total).toBe(0);
  });
});
