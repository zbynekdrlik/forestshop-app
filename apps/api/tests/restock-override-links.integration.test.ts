import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import {
  pairingDecisions,
  pairingVariantLinks,
  productSupplierLinkOverrides,
  products,
  supplierStock,
  users,
  variants,
} from "../src/db/schema.js";
import { selectRestockCandidates } from "../src/modules/restock/queries.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";

// issue 565: efektívny odkaz reštok kandidáta musí použiť
// `product_supplier_link_override` v ROVNAKOM poradí ako `collectSupplierLinks`
// (`supplier-stock/run.ts`) a `resolveEffectiveSupplierLink`
// (`orders/effective-supplier-link.ts`): split per-veľkosť linka → override →
// URL z `internal_note`. Bez override vetvy sa produkt, ktorému majiteľ nastaví
// odkaz cez Vyhľadať, scrapuje, ale reštok ho pri prepínaní Vypredané → Skladom
// nikdy nenájde (JOIN `supplier_stock.link = link` hľadá pod inou linkou).

const NOW = new Date("2026-09-18T04:50:00.000Z");
const OVERRIDE_URL = "https://dodavatel.example/override-odkaz";
const NOTE_URL = "https://dodavatel.example/z-poznamky";
const SPLIT_URL = "https://dodavatel.example/velkost-L";

describe("restock kandidáti — product_supplier_link_override (issue 565)", () => {
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

  async function seedProduct(opts: {
    internalNote: string | null;
    override: string | null;
    split: boolean;
  }): Promise<void> {
    await db.insert(products).values({
      key: "OVR",
      name: "Override produkt",
      supplier: "Dodávateľ",
      internalNote: opts.internalNote,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      lastSeenSnapshotId: snapshotId,
    });
    await db.insert(variants).values({
      code: "OVR/L",
      productKey: "OVR",
      guid: "OVR",
      sizeLabel: "L",
      name: "Override produkt",
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
    if (opts.override !== null) {
      await db
        .insert(productSupplierLinkOverrides)
        .values({ productKey: "OVR", url: opts.override, updatedAt: NOW });
    }
    if (opts.split) {
      await db.insert(pairingDecisions).values({
        productKey: "OVR",
        status: "split",
        url: null,
        decidedBy: userId,
        decidedAt: NOW,
        updatedAt: NOW,
      });
      await db.insert(pairingVariantLinks).values({ code: "OVR/L", url: SPLIT_URL, updatedAt: NOW });
    }
  }

  // Stránka override odkazu je bežná viac-veľkostná/blanket stránka → scraper ju
  // zapíše ako blanket riadok (`size_label=''`), rovnako ako v split teste.
  async function seedBlanketSupplierStock(
    link: string,
    availability: "available" | "unavailable",
  ): Promise<void> {
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

  it("makes a variant a candidate via its product_supplier_link_override (no internal_note link)", async () => {
    await seedProduct({ internalNote: null, override: OVERRIDE_URL, split: false });
    await seedBlanketSupplierStock(OVERRIDE_URL, "available");

    const { picked } = await selectRestockCandidates(db, NOW);
    expect(picked.map((c) => c.variantCode)).toEqual(["OVR/L"]);
    expect(picked[0]?.supplierLink).toBe(OVERRIDE_URL);
  });

  it("the override BEATS an internal_note URL (same precedence as collectSupplierLinks)", async () => {
    await seedProduct({ internalNote: NOTE_URL, override: OVERRIDE_URL, split: false });
    // both supplier rows available — the candidate must be keyed by the override
    await seedBlanketSupplierStock(NOTE_URL, "available");
    await seedBlanketSupplierStock(OVERRIDE_URL, "available");

    const { picked } = await selectRestockCandidates(db, NOW);
    expect(picked.map((c) => c.variantCode)).toEqual(["OVR/L"]);
    expect(picked[0]?.supplierLink).toBe(OVERRIDE_URL);
  });

  it("a SPLIT per-size link still wins over the override (split → override → internal_note)", async () => {
    await seedProduct({ internalNote: NOTE_URL, override: OVERRIDE_URL, split: true });
    await seedBlanketSupplierStock(NOTE_URL, "available");
    await seedBlanketSupplierStock(OVERRIDE_URL, "available");
    await seedBlanketSupplierStock(SPLIT_URL, "available");

    const { picked } = await selectRestockCandidates(db, NOW);
    expect(picked.map((c) => c.variantCode)).toEqual(["OVR/L"]);
    expect(picked[0]?.supplierLink).toBe(SPLIT_URL);
  });
});
