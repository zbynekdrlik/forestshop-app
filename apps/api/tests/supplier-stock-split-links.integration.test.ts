import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { pairingDecisions, pairingVariantLinks, users } from "../src/db/schema.js";
import { collectSupplierLinks } from "../src/modules/supplier-stock/run.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariantForProduct } from "./helpers/orders.js";

// issue 423: `collectSupplierLinks` musí navyše pozbierať split-riadené
// per-veľkosť linky (`pairing_variant_link` pre variant produktu s
// `pairing_decision.status='split'`) — inak sa veľkosti split produktu nikdy
// nescrapujú.

describe("collectSupplierLinks — split per-veľkosť linky (issue 423)", () => {
  let db: Database;
  let close: () => Promise<void>;
  let userId: string;

  async function splitDecision(productKey: string): Promise<void> {
    await db.insert(pairingDecisions).values({
      productKey,
      status: "split",
      url: null,
      decidedBy: userId,
      decidedAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
  }

  beforeEach(async () => {
    ({ db, close } = await withCleanDb());
    const [row] = await db
      .insert(users)
      .values({ email: "d@forestshop.sk", passwordHash: "x", displayName: "D", role: "manazer" })
      .returning({ id: users.id });
    if (row === undefined) throw new Error("user");
    userId = row.id;
  });
  afterEach(async () => {
    await close();
  });

  it("includes a SPLIT product's per-size links alongside product-level internalNote links", async () => {
    // product-level linked product
    await insertTestVariantForProduct(db, "PROD", "PROD/1", { internalNote: "https://dodavatel.example/prod" });
    // split product: per-size links, product has NO internalNote of its own
    await insertTestVariantForProduct(db, "SPLIT", "SPLIT/S", { sizeLabel: "S", internalNote: null });
    await insertTestVariantForProduct(db, "SPLIT", "SPLIT/M", { sizeLabel: "M", internalNote: null });
    await splitDecision("SPLIT");
    await db.insert(pairingVariantLinks).values([
      { code: "SPLIT/S", url: "https://dodavatel.example/velkost-S", updatedAt: new Date("2026-01-02T00:00:00Z") },
      { code: "SPLIT/M", url: "https://dodavatel.example/velkost-M", updatedAt: new Date("2026-01-02T00:00:00Z") },
    ]);

    const links = await collectSupplierLinks(db);
    expect(links).toEqual([
      "https://dodavatel.example/prod",
      "https://dodavatel.example/velkost-M",
      "https://dodavatel.example/velkost-S",
    ]);
  });

  it("does NOT include a DORMANT per-size link whose product is not split", async () => {
    await insertTestVariantForProduct(db, "P2", "P2/S", { sizeLabel: "S", internalNote: null });
    // per-size link set but no split decision
    await db.insert(pairingVariantLinks).values({ code: "P2/S", url: "https://dodavatel.example/S", updatedAt: new Date("2026-01-02T00:00:00Z") });

    const links = await collectSupplierLinks(db);
    expect(links).toEqual([]);
  });

  it("excludes a split per-size link that points to OUR OWN e-shop (issue 227 discipline)", async () => {
    await insertTestVariantForProduct(db, "P3", "P3/S", { sizeLabel: "S", internalNote: null });
    await splitDecision("P3");
    await db.insert(pairingVariantLinks).values({ code: "P3/S", url: "https://www.forestshop.sk/produkt-x", updatedAt: new Date("2026-01-02T00:00:00Z") });

    const links = await collectSupplierLinks(db);
    expect(links).toEqual([]);
  });
});
