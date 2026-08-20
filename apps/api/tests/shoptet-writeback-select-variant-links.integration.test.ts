import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { pairingDecisions, pairingVariantLinks, users } from "../src/db/schema.js";
import { selectChangedVariantLinks } from "../src/modules/shoptet-writeback/select-variant-links.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariantForProduct } from "./helpers/orders.js";

// issue 423: mirror `shoptet-writeback-select.integration.test.ts` /
// `select-states`, teraz nad `pairing_variant_link` (per-veľkosť split
// linky). Kľúčový rozdiel: GATE na `pairing_decision.status='split'` —
// dormantná per-veľkosť linka (produkt nerozdelený) sa NIKDY neposiela.

describe("selectChangedVariantLinks", () => {
  let db: Database;
  let close: () => Promise<void>;
  let userId: string;

  async function splitProduct(productKey: string, decidedAt = new Date("2026-01-01T00:00:00Z")): Promise<void> {
    await db.insert(pairingDecisions).values({
      productKey,
      status: "split",
      url: null,
      decidedBy: userId,
      decidedAt,
      updatedAt: decidedAt,
    });
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

  it("returns no rows when there are no variant links at all", async () => {
    const result = await selectChangedVariantLinks(db);
    expect(result.codes).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("emits ONE row per never-synced per-size link of a SPLIT product, carrying code+pairCode+its OWN url", async () => {
    await insertTestVariantForProduct(db, "P1", "P1/S", { pairCode: "1001", sizeLabel: "S" });
    await insertTestVariantForProduct(db, "P1", "P1/M", { pairCode: "1002", sizeLabel: "M" });
    await splitProduct("P1");
    await db.insert(pairingVariantLinks).values([
      { code: "P1/S", url: "https://dodavatel.example/S", updatedAt: new Date("2026-01-02T00:00:00Z") },
      { code: "P1/M", url: "https://dodavatel.example/M", updatedAt: new Date("2026-01-02T00:00:00Z") },
    ]);

    const result = await selectChangedVariantLinks(db);
    expect(result.codes.slice().sort()).toEqual(["P1/M", "P1/S"]);
    expect(result.rows).toEqual(
      expect.arrayContaining([
        { code: "P1/S", pairCode: "1001", internalNote: "https://dodavatel.example/S" },
        { code: "P1/M", pairCode: "1002", internalNote: "https://dodavatel.example/M" },
      ]),
    );
  });

  it("NEVER emits a DORMANT per-size link whose product is NOT split (staged but not committed)", async () => {
    await insertTestVariantForProduct(db, "P2", "P2/S", { pairCode: "1", sizeLabel: "S" });
    // no split decision — the manager set the link in the panel but never clicked "✓ Hotovo"
    await db
      .insert(pairingVariantLinks)
      .values({ code: "P2/S", url: "https://dodavatel.example/S", updatedAt: new Date("2026-01-02T00:00:00Z") });

    const result = await selectChangedVariantLinks(db);
    expect(result.codes).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("does NOT emit a per-size link whose product decision reverted away from split", async () => {
    await insertTestVariantForProduct(db, "P3", "P3/S", { pairCode: "1", sizeLabel: "S" });
    await db.insert(pairingDecisions).values({
      productKey: "P3",
      status: "good",
      url: "https://dodavatel.example/product",
      decidedBy: userId,
      decidedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db
      .insert(pairingVariantLinks)
      .values({ code: "P3/S", url: "https://dodavatel.example/S", updatedAt: new Date("2026-01-02T00:00:00Z") });

    const result = await selectChangedVariantLinks(db);
    expect(result.codes).toEqual([]);
  });

  it("excludes a per-size link already synced AFTER its last update (nothing changed since)", async () => {
    await insertTestVariantForProduct(db, "P4", "P4/S", { pairCode: "1", sizeLabel: "S" });
    await splitProduct("P4");
    await db.insert(pairingVariantLinks).values({
      code: "P4/S",
      url: "https://dodavatel.example/S",
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      syncedAt: new Date("2026-01-02T00:00:00Z"),
    });

    const result = await selectChangedVariantLinks(db);
    expect(result.codes).toEqual([]);
  });

  it("includes a per-size link whose updatedAt moved PAST its last syncedAt (changed again after a sync)", async () => {
    await insertTestVariantForProduct(db, "P5", "P5/S", { pairCode: "1", sizeLabel: "S" });
    await splitProduct("P5");
    await db.insert(pairingVariantLinks).values({
      code: "P5/S",
      url: "https://dodavatel.example/S-new",
      updatedAt: new Date("2026-01-03T00:00:00Z"),
      syncedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await selectChangedVariantLinks(db);
    expect(result.codes).toEqual(["P5/S"]);
    expect(result.rows).toEqual([{ code: "P5/S", pairCode: "1", internalNote: "https://dodavatel.example/S-new" }]);
  });

  it("issue 465: NEVER emits a split per-size link whose variant went missing from Shoptet (missing_since set), still emits its LIVE sibling", async () => {
    // same hole as the product path — a per-size link for a variant Shoptet no
    // longer has would poison the merged import; it must be excluded here too.
    await insertTestVariantForProduct(db, "P6", "P6/S", { pairCode: "1", sizeLabel: "S" });
    await insertTestVariantForProduct(db, "P6", "P6/M", {
      pairCode: "2",
      sizeLabel: "M",
      missingSince: new Date("2026-08-13T09:22:02Z"),
    });
    await splitProduct("P6");
    await db.insert(pairingVariantLinks).values([
      { code: "P6/S", url: "https://dodavatel.example/S", updatedAt: new Date("2026-01-02T00:00:00Z") },
      { code: "P6/M", url: "https://dodavatel.example/M", updatedAt: new Date("2026-01-02T00:00:00Z") },
    ]);

    const result = await selectChangedVariantLinks(db);
    // only the LIVE size — the missing one is excluded (never sent, never marked)
    expect(result.codes).toEqual(["P6/S"]);
    expect(result.rows).toEqual([{ code: "P6/S", pairCode: "1", internalNote: "https://dodavatel.example/S" }]);
  });
});
