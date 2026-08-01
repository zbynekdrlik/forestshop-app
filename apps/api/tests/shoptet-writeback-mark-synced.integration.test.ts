import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { productSupplierLinkOverrides } from "../src/db/schema.js";
import { markSuppliersLinksSynced } from "../src/modules/shoptet-writeback/mark-synced.js";
import { selectChangedSupplierLinks } from "../src/modules/shoptet-writeback/select-changes.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariantForProduct } from "./helpers/orders.js";

describe("markSuppliersLinksSynced", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await withCleanDb());
  });

  afterEach(async () => {
    await close();
  });

  it("sets syncedAt on exactly the given productKeys, leaving an untouched sibling row alone", async () => {
    await insertTestVariantForProduct(db, "P1", "P1", {});
    await insertTestVariantForProduct(db, "P2", "P2", {});
    await db.insert(productSupplierLinkOverrides).values([
      { productKey: "P1", url: "https://x.example/p1", updatedAt: new Date("2026-01-01T00:00:00Z") },
      { productKey: "P2", url: "https://x.example/p2", updatedAt: new Date("2026-01-01T00:00:00Z") },
    ]);

    await markSuppliersLinksSynced(db, ["P1"], new Date("2026-02-01T00:00:00Z"));

    const [p1] = await db
      .select({ syncedAt: productSupplierLinkOverrides.syncedAt })
      .from(productSupplierLinkOverrides)
      .where(eq(productSupplierLinkOverrides.productKey, "P1"));
    const [p2] = await db
      .select({ syncedAt: productSupplierLinkOverrides.syncedAt })
      .from(productSupplierLinkOverrides)
      .where(eq(productSupplierLinkOverrides.productKey, "P2"));
    expect(p1?.syncedAt?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(p2?.syncedAt).toBeNull();
  });

  it("removes the marked products from the next selectChangedSupplierLinks() result", async () => {
    await insertTestVariantForProduct(db, "P3", "P3", {});
    await db
      .insert(productSupplierLinkOverrides)
      .values({ productKey: "P3", url: "https://x.example/p3", updatedAt: new Date("2026-01-01T00:00:00Z") });

    expect((await selectChangedSupplierLinks(db)).productKeys).toEqual(["P3"]);
    await markSuppliersLinksSynced(db, ["P3"], new Date("2026-01-02T00:00:00Z"));
    expect((await selectChangedSupplierLinks(db)).productKeys).toEqual([]);
  });

  it("is a no-op for an empty productKeys list", async () => {
    await insertTestVariantForProduct(db, "P4", "P4", {});
    await db
      .insert(productSupplierLinkOverrides)
      .values({ productKey: "P4", url: "https://x.example/p4", updatedAt: new Date("2026-01-01T00:00:00Z") });

    await markSuppliersLinksSynced(db, [], new Date("2026-01-02T00:00:00Z"));
    expect((await selectChangedSupplierLinks(db)).productKeys).toEqual(["P4"]);
  });
});
