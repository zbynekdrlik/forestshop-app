import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { pairingDecisions, pairingVariantLinks, products, productSupplierLinkOverrides, users } from "../src/db/schema.js";
import { selectChangedSupplierLinks } from "../src/modules/shoptet-writeback/select-changes.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
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

  // issue 423: seedne split rozhodnutie na produkte (potrebný používateľ pre
  // `decidedBy`), aby sa variant s per-veľkosť linkom stal "split-riadeným".
  async function seedSplitDecision(productKey: string): Promise<void> {
    const [user] = await db
      .insert(users)
      .values({ email: `d-${productKey}@forestshop.sk`, passwordHash: "x", displayName: "D", role: "manazer" })
      .returning({ id: users.id });
    if (user === undefined) throw new Error("používateľ sa nepodarilo vložiť");
    await db.insert(pairingDecisions).values({
      productKey,
      status: "split",
      url: null,
      decidedBy: user.id,
      decidedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
  }

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

  it("skips (never crashes on) a changed override whose product has zero variants — a data anomaly, not a normal case", async () => {
    const snapshotId = await insertTestSnapshot(db);
    await db.insert(products).values({
      key: "P7-NO-VARIANTS",
      name: "Produkt bez variantu (anomália)",
      supplier: null,
      firstSeenAt: new Date("2026-01-01T00:00:00Z"),
      lastSeenAt: new Date("2026-01-01T00:00:00Z"),
      lastSeenSnapshotId: snapshotId,
    });
    await db.insert(productSupplierLinkOverrides).values({
      productKey: "P7-NO-VARIANTS",
      url: "https://dodavatel.example/p7",
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await selectChangedSupplierLinks(db);
    expect(result.productKeys).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  // ── issue 423: split-governed variants excluded from the product path ──

  it("EXCLUDES a split-governed variant (per-size link AND product split), still emits its non-split siblings", async () => {
    await insertTestVariantForProduct(db, "P8", "P8/S", { pairCode: "1", sizeLabel: "S" });
    await insertTestVariantForProduct(db, "P8", "P8/M", { pairCode: "2", sizeLabel: "M" });
    await seedSplitDecision("P8");
    // only P8/S has a per-size link → only P8/S is split-governed and excluded
    await db.insert(pairingVariantLinks).values({ code: "P8/S", url: "https://dodavatel.example/S", updatedAt: new Date("2026-01-02T00:00:00Z") });
    await db
      .insert(productSupplierLinkOverrides)
      .values({ productKey: "P8", url: "https://dodavatel.example/produkt", updatedAt: new Date("2026-01-02T00:00:00Z") });

    const result = await selectChangedSupplierLinks(db);
    // P8/M (no per-size link) still gets the product override; P8/S excluded
    expect(result.rows).toEqual([{ code: "P8/M", pairCode: "2", internalNote: "https://dodavatel.example/produkt" }]);
    // the override still owns a variant → marked (not looped)
    expect(result.productKeys).toEqual(["P8"]);
  });

  it("still writes the product override to a variant with a DORMANT per-size link (product NOT split)", async () => {
    await insertTestVariantForProduct(db, "P9", "P9/S", { pairCode: "1", sizeLabel: "S" });
    // per-size link exists but no split decision → dormant, product path owns it
    await db.insert(pairingVariantLinks).values({ code: "P9/S", url: "https://dodavatel.example/S", updatedAt: new Date("2026-01-02T00:00:00Z") });
    await db
      .insert(productSupplierLinkOverrides)
      .values({ productKey: "P9", url: "https://dodavatel.example/produkt", updatedAt: new Date("2026-01-02T00:00:00Z") });

    const result = await selectChangedSupplierLinks(db);
    expect(result.rows).toEqual([{ code: "P9/S", pairCode: "1", internalNote: "https://dodavatel.example/produkt" }]);
    expect(result.productKeys).toEqual(["P9"]);
  });

  it("a FULLY-split product with a changed override emits ZERO rows but is still marked (not a no-variant anomaly)", async () => {
    await insertTestVariantForProduct(db, "P10", "P10/S", { pairCode: "1", sizeLabel: "S" });
    await insertTestVariantForProduct(db, "P10", "P10/M", { pairCode: "2", sizeLabel: "M" });
    await seedSplitDecision("P10");
    await db.insert(pairingVariantLinks).values([
      { code: "P10/S", url: "https://dodavatel.example/S", updatedAt: new Date("2026-01-02T00:00:00Z") },
      { code: "P10/M", url: "https://dodavatel.example/M", updatedAt: new Date("2026-01-02T00:00:00Z") },
    ]);
    await db
      .insert(productSupplierLinkOverrides)
      .values({ productKey: "P10", url: "https://dodavatel.example/dormant", updatedAt: new Date("2026-01-02T00:00:00Z") });

    const result = await selectChangedSupplierLinks(db);
    // all variants split-governed → nothing to send from the product path
    expect(result.rows).toEqual([]);
    // BUT the override is dormant (covered by per-size links) → marked, so it
    // never re-selects forever; NOT reported as the "no variant" anomaly
    expect(result.productKeys).toEqual(["P10"]);
  });
});
