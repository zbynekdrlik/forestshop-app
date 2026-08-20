import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { pairingDecisions, products, users } from "../src/db/schema.js";
import { selectChangedStateDecisions } from "../src/modules/shoptet-writeback/select-states.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariantForProduct } from "./helpers/orders.js";

// issue 387 E7: mirror `shoptet-writeback-select.integration.test.ts` (issue
// 122's `selectChangedSupplierLinks`), teraz nad `pairing_decision`'s
// terminálne stavy (unavailable/discontinued) namiesto `product_supplier_
// link_override`.

describe("selectChangedStateDecisions", () => {
  let db: Database;
  let close: () => Promise<void>;
  let userId: string;

  beforeEach(async () => {
    ({ db, close } = await withCleanDb());
    const [row] = await db
      .insert(users)
      .values({ email: "rozhodca@forestshop.sk", passwordHash: "x", displayName: "Rozhodca", role: "manazer" })
      .returning({ id: users.id });
    if (row === undefined) throw new Error("testovací používateľ sa nepodarilo vložiť");
    userId = row.id;
  });

  afterEach(async () => {
    await close();
  });

  it("returns no rows when there are no decisions at all", async () => {
    const result = await selectChangedStateDecisions(db);
    expect(result.productKeys).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("emits ONE row per variant of a never-synced unavailable decision, mapping code+pairCode+status", async () => {
    await insertTestVariantForProduct(db, "P1", "P1/S", { pairCode: "1001" });
    await insertTestVariantForProduct(db, "P1", "P1/M", { pairCode: "1002" });
    await db.insert(pairingDecisions).values({
      productKey: "P1",
      status: "unavailable",
      url: null,
      decidedBy: userId,
      decidedAt: new Date("2026-01-02T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    });

    const result = await selectChangedStateDecisions(db);
    expect(result.productKeys).toEqual(["P1"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows).toEqual(
      expect.arrayContaining([
        { code: "P1/S", pairCode: "1001", status: "unavailable" },
        { code: "P1/M", pairCode: "1002", status: "unavailable" },
      ]),
    );
  });

  it("emits a discontinued decision's variants with status 'discontinued'", async () => {
    await insertTestVariantForProduct(db, "P2", "P2", {});
    await db.insert(pairingDecisions).values({
      productKey: "P2",
      status: "discontinued",
      url: null,
      decidedBy: userId,
      decidedAt: new Date("2026-01-02T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    });

    const result = await selectChangedStateDecisions(db);
    expect(result.rows).toEqual([{ code: "P2", pairCode: "", status: "discontinued" }]);
  });

  it("excludes 'good'/'manual' decisions — those go through the existing internalNote path, never a stavová CSV riadok", async () => {
    await insertTestVariantForProduct(db, "P3", "P3", {});
    await db.insert(pairingDecisions).values({
      productKey: "P3",
      status: "good",
      url: "https://dodavatel.example/p3",
      decidedBy: userId,
      decidedAt: new Date("2026-01-02T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    });

    const result = await selectChangedStateDecisions(db);
    expect(result.productKeys).toEqual([]);
  });

  it("excludes a decision already state-synced AFTER its last update (nothing changed since)", async () => {
    await insertTestVariantForProduct(db, "P4", "P4", {});
    await db.insert(pairingDecisions).values({
      productKey: "P4",
      status: "unavailable",
      url: null,
      decidedBy: userId,
      decidedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      stateSyncedAt: new Date("2026-01-02T00:00:00Z"),
    });

    const result = await selectChangedStateDecisions(db);
    expect(result.productKeys).toEqual([]);
  });

  it("includes a decision whose updatedAt moved PAST its last stateSyncedAt (changed again after a sync)", async () => {
    await insertTestVariantForProduct(db, "P5", "P5", {});
    await db.insert(pairingDecisions).values({
      productKey: "P5",
      status: "discontinued",
      url: null,
      decidedBy: userId,
      decidedAt: new Date("2026-01-03T00:00:00Z"),
      updatedAt: new Date("2026-01-03T00:00:00Z"),
      stateSyncedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await selectChangedStateDecisions(db);
    expect(result.productKeys).toEqual(["P5"]);
  });

  it("skips (never crashes on) a changed decision whose product has zero variants — a data anomaly", async () => {
    // A pairing_decision row requires the referenced product to already
    // exist (FK) — insert one directly with no variant, mirroring
    // `shoptet-writeback-select.integration.test.ts`'s equivalent case.
    const snapshotId = await insertTestSnapshot(db);
    await db.insert(products).values({
      key: "P6-NO-VARIANTS",
      name: "Produkt bez variantu (anomália)",
      supplier: null,
      firstSeenAt: new Date("2026-01-01T00:00:00Z"),
      lastSeenAt: new Date("2026-01-01T00:00:00Z"),
      lastSeenSnapshotId: snapshotId,
    });
    await db.insert(pairingDecisions).values({
      productKey: "P6-NO-VARIANTS",
      status: "unavailable",
      url: null,
      decidedBy: userId,
      decidedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await selectChangedStateDecisions(db);
    expect(result.productKeys).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("only reports the productKeys of rows actually selected — a synced-and-unchanged sibling stays excluded", async () => {
    await insertTestVariantForProduct(db, "P7", "P7", {});
    await insertTestVariantForProduct(db, "P8", "P8", {});
    await db.insert(pairingDecisions).values([
      {
        productKey: "P7",
        status: "unavailable",
        url: null,
        decidedBy: userId,
        decidedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        stateSyncedAt: new Date("2026-01-02T00:00:00Z"),
      },
      {
        productKey: "P8",
        status: "unavailable",
        url: null,
        decidedBy: userId,
        decidedAt: new Date("2026-01-02T00:00:00Z"),
        updatedAt: new Date("2026-01-02T00:00:00Z"),
      },
    ]);

    const result = await selectChangedStateDecisions(db);
    expect(result.productKeys).toEqual(["P8"]);

    const all = await db.select().from(pairingDecisions).where(eq(pairingDecisions.productKey, "P7"));
    expect(all).toHaveLength(1);
  });

  it("issue 465: EXCLUDES a variant that went missing from Shoptet (missing_since set) from the state CSV, still emits its LIVE siblings", async () => {
    // Same missing_since poison class as the link write-back (issue 465): a
    // discontinued/unavailable product whose variant Shoptet no longer has must
    // NOT push that dead code into the state CSV (Shoptet rejects the whole
    // batch → run-state-writeback marks nothing → same infinite-retry poison).
    await insertTestVariantForProduct(db, "P465S", "P465S/LIVE", { pairCode: "7" });
    await insertTestVariantForProduct(db, "P465S", "P465S/DEAD", {
      pairCode: "7",
      missingSince: new Date("2026-08-13T09:22:02Z"),
    });
    await db.insert(pairingDecisions).values({
      productKey: "P465S",
      status: "discontinued",
      url: null,
      decidedBy: userId,
      decidedAt: new Date("2026-01-02T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    });

    const result = await selectChangedStateDecisions(db);
    expect(result.rows).toEqual([{ code: "P465S/LIVE", pairCode: "7", status: "discontinued" }]);
    expect(result.rows.map((r) => r.code)).not.toContain("P465S/DEAD");
    // still owns a live variant → marked after a successful import
    expect(result.productKeys).toEqual(["P465S"]);
  });
});
