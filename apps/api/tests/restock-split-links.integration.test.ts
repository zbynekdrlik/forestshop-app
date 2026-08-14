import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { pairingDecisions, pairingVariantLinks, products, supplierStock, users, variants } from "../src/db/schema.js";
import { selectRestockCandidates } from "../src/modules/restock/queries.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";

// issue 423: split-riadený variant má VLASTNÚ per-veľkosť linku (nie
// produktovú `internalNote`) — `allRestockCandidates` ju musí použiť ako
// efektívnu linku a spárovať na jej blanket `supplier_stock` riadok, inak sa
// split veľkosť nikdy neprepne späť na "Skladom".

const NOW = new Date("2026-08-04T04:50:00.000Z");
const SPLIT_URL = "https://dodavatel.example/velkost-L";

describe("restock kandidáti — split per-veľkosť linky (issue 423)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let snapshotId: string;
  let userId: string;

  beforeEach(async () => {
    ({ db, close } = await withCleanDb());
    snapshotId = await insertTestSnapshot(db);
    const [user] = await db
      .insert(users)
      .values({ email: "d@forestshop.sk", passwordHash: "x", displayName: "D", role: "manazer" })
      .returning({ id: users.id });
    if (user === undefined) throw new Error("user");
    userId = user.id;
  });
  afterEach(async () => {
    await close();
  });

  async function seedSplitVariant(opts: { split: boolean; internalNote: string | null }): Promise<void> {
    await db.insert(products).values({
      key: "SPLIT",
      name: "Split produkt",
      supplier: "Dodávateľ",
      internalNote: opts.internalNote,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      lastSeenSnapshotId: snapshotId,
    });
    await db.insert(variants).values({
      code: "SPLIT/L",
      productKey: "SPLIT",
      guid: "SPLIT",
      sizeLabel: "L",
      name: "Split produkt",
      stock: 0,
      availabilityInStockText: "Skladom",
      availabilityOutOfStockText: "Vypredané",
      availabilityText: "Vypredané",
      productVisibility: "visible",
      state: "out_of_stock",
      missingSince: null,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      lastSeenSnapshotId: snapshotId,
    });
    if (opts.split) {
      await db.insert(pairingDecisions).values({
        productKey: "SPLIT",
        status: "split",
        url: null,
        decidedBy: userId,
        decidedAt: NOW,
        updatedAt: NOW,
      });
    }
    await db.insert(pairingVariantLinks).values({ code: "SPLIT/L", url: SPLIT_URL, updatedAt: NOW });
  }

  // The supplier page for a per-size split link is a single-size page → the
  // scraper writes it as a BLANKET row (size_label='').
  async function seedBlanketSupplierStock(link: string, availability: "available" | "unavailable"): Promise<void> {
    await db.insert(supplierStock).values({
      link,
      sizeLabel: "",
      host: "dodavatel.example",
      availability,
      availabilityText: availability === "available" ? "skladom" : "vypredané",
      price: "12.50",
      source: "json_ld",
      ok: true,
      error: null,
      httpStatus: 200,
      checkedAt: NOW,
      confirmedAt: new Date(NOW.getTime() - 3_600_000),
    });
  }

  it("makes a SPLIT variant a candidate when its own per-size link is confirmed available", async () => {
    await seedSplitVariant({ split: true, internalNote: null });
    await seedBlanketSupplierStock(SPLIT_URL, "available");

    const { picked } = await selectRestockCandidates(db, NOW);
    expect(picked.map((c) => c.variantCode)).toEqual(["SPLIT/L"]);
    expect(picked[0]?.supplierLink).toBe(SPLIT_URL);
  });

  it("does NOT make a DORMANT per-size link (product not split) a candidate — falls back to the (null) product link", async () => {
    await seedSplitVariant({ split: false, internalNote: null });
    await seedBlanketSupplierStock(SPLIT_URL, "available");

    const { picked } = await selectRestockCandidates(db, NOW);
    expect(picked).toEqual([]);
  });

  it("for a DORMANT per-size link uses the PRODUCT link, not the per-size one (coalesce fallback)", async () => {
    const PRODUCT_URL = "https://dodavatel.example/produkt-cely";
    await seedSplitVariant({ split: false, internalNote: PRODUCT_URL });
    // the per-size link's own supplier row is AVAILABLE but must be IGNORED
    await seedBlanketSupplierStock(SPLIT_URL, "available");
    // the PRODUCT link's supplier row is what must drive the candidate
    await seedBlanketSupplierStock(PRODUCT_URL, "available");

    const { picked } = await selectRestockCandidates(db, NOW);
    expect(picked.map((c) => c.variantCode)).toEqual(["SPLIT/L"]);
    expect(picked[0]?.supplierLink).toBe(PRODUCT_URL);
  });

  it("does NOT switch a split variant whose per-size link the supplier reports unavailable", async () => {
    await seedSplitVariant({ split: true, internalNote: null });
    await seedBlanketSupplierStock(SPLIT_URL, "unavailable");

    const { picked } = await selectRestockCandidates(db, NOW);
    expect(picked).toEqual([]);
  });
});
