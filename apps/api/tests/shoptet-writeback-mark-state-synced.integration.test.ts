import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { pairingDecisions, users } from "../src/db/schema.js";
import { markStateSynced } from "../src/modules/shoptet-writeback/mark-state-synced.js";
import { selectChangedStateDecisions } from "../src/modules/shoptet-writeback/select-states.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariantForProduct } from "./helpers/orders.js";

// issue 387 E7: mirror `shoptet-writeback-mark-synced.integration.test.ts`
// (issue 122's `markSuppliersLinksSynced`), teraz nad `pairing_decision
// .state_synced_at`.

describe("markStateSynced", () => {
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

  it("sets stateSyncedAt on exactly the given productKeys, leaving an untouched sibling row alone", async () => {
    await insertTestVariantForProduct(db, "P1", "P1", {});
    await insertTestVariantForProduct(db, "P2", "P2", {});
    await db.insert(pairingDecisions).values([
      {
        productKey: "P1",
        status: "unavailable",
        url: null,
        decidedBy: userId,
        decidedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        productKey: "P2",
        status: "unavailable",
        url: null,
        decidedBy: userId,
        decidedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    await markStateSynced(db, ["P1"], new Date("2026-02-01T00:00:00Z"));

    const [p1] = await db.select({ v: pairingDecisions.stateSyncedAt }).from(pairingDecisions).where(eq(pairingDecisions.productKey, "P1"));
    const [p2] = await db.select({ v: pairingDecisions.stateSyncedAt }).from(pairingDecisions).where(eq(pairingDecisions.productKey, "P2"));
    expect(p1?.v?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(p2?.v).toBeNull();
  });

  it("removes the marked products from the next selectChangedStateDecisions() result", async () => {
    await insertTestVariantForProduct(db, "P3", "P3", {});
    await db.insert(pairingDecisions).values({
      productKey: "P3",
      status: "discontinued",
      url: null,
      decidedBy: userId,
      decidedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect((await selectChangedStateDecisions(db)).productKeys).toEqual(["P3"]);
    await markStateSynced(db, ["P3"], new Date("2026-01-02T00:00:00Z"));
    expect((await selectChangedStateDecisions(db)).productKeys).toEqual([]);
  });

  it("is a no-op for an empty productKeys list", async () => {
    await insertTestVariantForProduct(db, "P4", "P4", {});
    await db.insert(pairingDecisions).values({
      productKey: "P4",
      status: "unavailable",
      url: null,
      decidedBy: userId,
      decidedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    await markStateSynced(db, [], new Date("2026-01-02T00:00:00Z"));
    expect((await selectChangedStateDecisions(db)).productKeys).toEqual(["P4"]);
  });

  it("does NOT mark a row synced if it was edited AGAIN after the run started (race window) — the next run must still pick it up", async () => {
    await insertTestVariantForProduct(db, "P5", "P5", {});
    // The run started at 10:00 (selected this row with updatedAt 09:00 — not
    // modelled here directly, only the END state matters); while the
    // (possibly slow, browser-driven) import was still in flight, the
    // decision was changed AGAIN at 10:05 — AFTER the run's start time but
    // BEFORE this markStateSynced call actually executes.
    await db.insert(pairingDecisions).values({
      productKey: "P5",
      status: "discontinued",
      url: null,
      decidedBy: userId,
      decidedAt: new Date("2026-01-01T10:05:00Z"),
      updatedAt: new Date("2026-01-01T10:05:00Z"),
    });

    await markStateSynced(db, ["P5"], new Date("2026-01-01T10:00:00Z"));

    const [row] = await db.select({ v: pairingDecisions.stateSyncedAt }).from(pairingDecisions).where(eq(pairingDecisions.productKey, "P5"));
    expect(row?.v).toBeNull();
    expect((await selectChangedStateDecisions(db)).productKeys).toEqual(["P5"]);
  });
});
