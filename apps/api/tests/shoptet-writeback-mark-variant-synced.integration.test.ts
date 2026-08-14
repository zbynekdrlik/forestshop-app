import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { pairingDecisions, pairingVariantLinks, users } from "../src/db/schema.js";
import { markVariantLinksSynced } from "../src/modules/shoptet-writeback/mark-variant-synced.js";
import { selectChangedVariantLinks } from "../src/modules/shoptet-writeback/select-variant-links.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariantForProduct } from "./helpers/orders.js";

// issue 423: mirror `shoptet-writeback-mark-synced.integration.test.ts`, len
// na `pairing_variant_link.synced_at` per `code`.

describe("markVariantLinksSynced", () => {
  let db: Database;
  let close: () => Promise<void>;
  let userId: string;

  async function splitProductWithLink(productKey: string, code: string, updatedAt: Date): Promise<void> {
    await insertTestVariantForProduct(db, productKey, code, { pairCode: "1", sizeLabel: "S" });
    await db.insert(pairingDecisions).values({
      productKey,
      status: "split",
      url: null,
      decidedBy: userId,
      decidedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(pairingVariantLinks).values({ code, url: `https://dodavatel.example/${code}`, updatedAt });
  }

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

  it("sets syncedAt on exactly the given codes, leaving an untouched sibling row alone", async () => {
    await splitProductWithLink("P1", "P1/S", new Date("2026-01-01T00:00:00Z"));
    await splitProductWithLink("P2", "P2/S", new Date("2026-01-01T00:00:00Z"));

    await markVariantLinksSynced(db, ["P1/S"], new Date("2026-02-01T00:00:00Z"));

    const [p1] = await db.select({ syncedAt: pairingVariantLinks.syncedAt }).from(pairingVariantLinks).where(eq(pairingVariantLinks.code, "P1/S"));
    const [p2] = await db.select({ syncedAt: pairingVariantLinks.syncedAt }).from(pairingVariantLinks).where(eq(pairingVariantLinks.code, "P2/S"));
    expect(p1?.syncedAt?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(p2?.syncedAt).toBeNull();
  });

  it("removes the marked codes from the next selectChangedVariantLinks() result", async () => {
    await splitProductWithLink("P3", "P3/S", new Date("2026-01-01T00:00:00Z"));

    expect((await selectChangedVariantLinks(db)).codes).toEqual(["P3/S"]);
    await markVariantLinksSynced(db, ["P3/S"], new Date("2026-01-02T00:00:00Z"));
    expect((await selectChangedVariantLinks(db)).codes).toEqual([]);
  });

  it("is a no-op for an empty codes list", async () => {
    await splitProductWithLink("P4", "P4/S", new Date("2026-01-01T00:00:00Z"));

    await markVariantLinksSynced(db, [], new Date("2026-01-02T00:00:00Z"));
    expect((await selectChangedVariantLinks(db)).codes).toEqual(["P4/S"]);
  });

  it("does NOT mark a code synced if it was edited AGAIN after the run started (race window)", async () => {
    // run started 10:00, selected the link (updatedAt 09:00); the owner
    // re-edited the SAME per-size link at 10:05, after the run's start but
    // before this mark call executes. Only the 09:00 value reached Shoptet.
    await splitProductWithLink("P5", "P5/S", new Date("2026-01-01T10:05:00Z"));

    await markVariantLinksSynced(db, ["P5/S"], new Date("2026-01-01T10:00:00Z"));

    const [row] = await db.select({ syncedAt: pairingVariantLinks.syncedAt }).from(pairingVariantLinks).where(eq(pairingVariantLinks.code, "P5/S"));
    expect(row?.syncedAt).toBeNull();
    expect((await selectChangedVariantLinks(db)).codes).toEqual(["P5/S"]);
  });
});
