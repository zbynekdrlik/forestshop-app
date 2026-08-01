import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { productSupplierLinkOverrides } from "../src/db/schema.js";
import { selectChangedSupplierLinks } from "../src/modules/shoptet-writeback/select-changes.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariantForProduct } from "./helpers/orders.js";

describe("selectChangedSupplierLinks", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await withCleanDb());
  });

  afterEach(async () => {
    await close();
  });

  it("returns no rows when there are no overrides at all", async () => {
    const result = await selectChangedSupplierLinks(db);
    expect(result.productKeys).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("emits ONE row per variant of a never-synced override, carrying code+pairCode+the override URL", async () => {
    await insertTestVariantForProduct(db, "P1", "P1/S", { pairCode: "1001" });
    await insertTestVariantForProduct(db, "P1", "P1/M", { pairCode: "1002" });
    await db.insert(productSupplierLinkOverrides).values({
      productKey: "P1",
      url: "https://dodavatel.example/p1",
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    });

    const result = await selectChangedSupplierLinks(db);
    expect(result.productKeys).toEqual(["P1"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows).toEqual(
      expect.arrayContaining([
        { code: "P1/S", pairCode: "1001", internalNote: "https://dodavatel.example/p1" },
        { code: "P1/M", pairCode: "1002", internalNote: "https://dodavatel.example/p1" },
      ]),
    );
  });

  it("uses an empty string for a variant with no pairCode (single-variant products have none)", async () => {
    await insertTestVariantForProduct(db, "P2", "P2", {});
    await db.insert(productSupplierLinkOverrides).values({
      productKey: "P2",
      url: "https://dodavatel.example/p2",
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    });

    const result = await selectChangedSupplierLinks(db);
    expect(result.rows).toEqual([{ code: "P2", pairCode: "", internalNote: "https://dodavatel.example/p2" }]);
  });

  it("excludes an override already synced AFTER its last update (nothing changed since)", async () => {
    await insertTestVariantForProduct(db, "P3", "P3", {});
    await db.insert(productSupplierLinkOverrides).values({
      productKey: "P3",
      url: "https://dodavatel.example/p3",
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      syncedAt: new Date("2026-01-02T00:00:00Z"),
    });

    const result = await selectChangedSupplierLinks(db);
    expect(result.productKeys).toEqual([]);
  });

  it("includes an override whose updatedAt moved PAST its last syncedAt (edited again after a sync)", async () => {
    await insertTestVariantForProduct(db, "P4", "P4", {});
    await db.insert(productSupplierLinkOverrides).values({
      productKey: "P4",
      url: "https://dodavatel.example/p4-new",
      updatedAt: new Date("2026-01-03T00:00:00Z"),
      syncedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await selectChangedSupplierLinks(db);
    expect(result.productKeys).toEqual(["P4"]);
    expect(result.rows).toEqual([{ code: "P4", pairCode: "", internalNote: "https://dodavatel.example/p4-new" }]);
  });

  it("only reports the productKeys of rows actually selected — a synced-and-unchanged sibling stays excluded", async () => {
    await insertTestVariantForProduct(db, "P5", "P5", {});
    await insertTestVariantForProduct(db, "P6", "P6", {});
    await db.insert(productSupplierLinkOverrides).values([
      {
        productKey: "P5",
        url: "https://dodavatel.example/p5",
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        syncedAt: new Date("2026-01-02T00:00:00Z"),
      },
      { productKey: "P6", url: "https://dodavatel.example/p6", updatedAt: new Date("2026-01-02T00:00:00Z") },
    ]);

    const result = await selectChangedSupplierLinks(db);
    expect(result.productKeys).toEqual(["P6"]);

    // sanity: the fixture really has both rows in the table
    const all = await db.select().from(productSupplierLinkOverrides).where(eq(productSupplierLinkOverrides.productKey, "P5"));
    expect(all).toHaveLength(1);
  });
});
