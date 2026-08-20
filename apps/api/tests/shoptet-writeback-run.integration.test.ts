import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { pairingDecisions, pairingVariantLinks, productSupplierLinkOverrides, users } from "../src/db/schema.js";
import { runShoptetWriteback } from "../src/modules/shoptet-writeback/run-writeback.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariantForProduct } from "./helpers/orders.js";
import { startShoptetFixture, type ShoptetFixture } from "./helpers/shoptet-fixture.js";

const TEST_TIMEOUT_MS = 120_000; // issue 460: realny Chromium (~16 s baseline) proti fixture + premenlivy CI runner — rezerva ~8x, nie band-aid (merane zo surodencov, nie odhad)

describe("runShoptetWriteback (end-to-end proti fixture)", () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let fixture: ShoptetFixture;

  beforeEach(async () => {
    ({ db, close: closeDb } = await withCleanDb());
    fixture = await startShoptetFixture({ user: "manager", password: "tajneheslo" });
    fixture.seedPastEntry();
  });

  afterEach(async () => {
    await closeDb();
    await fixture.close();
  });

  function fixtureConfig(): {
    loginUrl: string;
    importUrl: string;
    logUrl: string;
    user: string;
    password: string;
  } {
    return {
      loginUrl: `${fixture.baseUrl}/admin/`,
      importUrl: `${fixture.baseUrl}/admin/import-produktov/`,
      logUrl: `${fixture.baseUrl}/admin/import-produktov/log/`,
      user: "manager",
      password: "tajneheslo",
    };
  }

  it(
    "reports 'nothing_changed' and touches nothing when there are no overrides",
    async () => {
      const result = await runShoptetWriteback(db, fixtureConfig(), new Date("2026-02-01T00:00:00Z"));
      expect(result).toEqual({ status: "nothing_changed" });
      expect(fixture.logEntryCount()).toBe(1); // only the seed — nothing uploaded
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "on a confirmed success marks the written-back products synced — a second run then reports nothing_changed",
    async () => {
      await insertTestVariantForProduct(db, "P1", "P1/S", { pairCode: "1" });
      await insertTestVariantForProduct(db, "P1", "P1/M", { pairCode: "2" });
      await db
        .insert(productSupplierLinkOverrides)
        .values({ productKey: "P1", url: "https://x.example/p1", updatedAt: new Date("2026-01-01T00:00:00Z") });

      const result = await runShoptetWriteback(db, fixtureConfig(), new Date("2026-02-01T00:00:00Z"));
      expect(result).toEqual({ status: "ok", productCount: 1, variantLinkCount: 0, rowCount: 2 });

      const [row] = await db
        .select({ syncedAt: productSupplierLinkOverrides.syncedAt })
        .from(productSupplierLinkOverrides)
        .where(eq(productSupplierLinkOverrides.productKey, "P1"));
      expect(row?.syncedAt?.toISOString()).toBe("2026-02-01T00:00:00.000Z");

      // second run: nothing changed since the sync above
      const second = await runShoptetWriteback(db, fixtureConfig(), new Date("2026-02-02T00:00:00Z"));
      expect(second).toEqual({ status: "nothing_changed" });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "issue 423: merges a product override AND a split product's per-size links into ONE import, marking BOTH synced",
    async () => {
      const [user] = await db
        .insert(users)
        .values({ email: "d@forestshop.sk", passwordHash: "x", displayName: "D", role: "manazer" })
        .returning({ id: users.id });
      if (user === undefined) throw new Error("user");

      // non-split product with a product-level override (1 variant)
      await insertTestVariantForProduct(db, "PROD", "PROD/1", { pairCode: "9" });
      await db
        .insert(productSupplierLinkOverrides)
        .values({ productKey: "PROD", url: "https://x.example/prod", updatedAt: new Date("2026-01-01T00:00:00Z") });

      // split product with 2 per-size links (no product override)
      await insertTestVariantForProduct(db, "SPLIT", "SPLIT/S", { pairCode: "1", sizeLabel: "S" });
      await insertTestVariantForProduct(db, "SPLIT", "SPLIT/M", { pairCode: "2", sizeLabel: "M" });
      await db.insert(pairingDecisions).values({
        productKey: "SPLIT",
        status: "split",
        url: null,
        decidedBy: user.id,
        decidedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      });
      await db.insert(pairingVariantLinks).values([
        { code: "SPLIT/S", url: "https://x.example/velkost-S", updatedAt: new Date("2026-01-01T00:00:00Z") },
        { code: "SPLIT/M", url: "https://x.example/velkost-M", updatedAt: new Date("2026-01-01T00:00:00Z") },
      ]);

      const result = await runShoptetWriteback(db, fixtureConfig(), new Date("2026-02-01T00:00:00Z"));
      // 1 product row + 2 per-size rows = 3 rows in the single merged import
      expect(result).toEqual({ status: "ok", productCount: 1, variantLinkCount: 2, rowCount: 3 });

      // both the product override AND both per-size links are marked synced
      const [prod] = await db
        .select({ syncedAt: productSupplierLinkOverrides.syncedAt })
        .from(productSupplierLinkOverrides)
        .where(eq(productSupplierLinkOverrides.productKey, "PROD"));
      expect(prod?.syncedAt?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
      const linkRows = await db.select({ code: pairingVariantLinks.code, syncedAt: pairingVariantLinks.syncedAt }).from(pairingVariantLinks);
      expect(linkRows.every((r) => r.syncedAt?.toISOString() === "2026-02-01T00:00:00.000Z")).toBe(true);

      // second run: nothing changed since the sync above
      const second = await runShoptetWriteback(db, fixtureConfig(), new Date("2026-02-02T00:00:00Z"));
      expect(second).toEqual({ status: "nothing_changed" });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "issue 423: a fully-split product's CHANGED but dormant override is marked synced even with nothing to upload (never re-selects forever)",
    async () => {
      const [user] = await db
        .insert(users)
        .values({ email: "d2@forestshop.sk", passwordHash: "x", displayName: "D", role: "manazer" })
        .returning({ id: users.id });
      if (user === undefined) throw new Error("user");

      // fully-split product: BOTH variants have per-size links, product split
      await insertTestVariantForProduct(db, "FS", "FS/S", { pairCode: "1", sizeLabel: "S" });
      await insertTestVariantForProduct(db, "FS", "FS/M", { pairCode: "2", sizeLabel: "M" });
      await db.insert(pairingDecisions).values({
        productKey: "FS",
        status: "split",
        url: null,
        decidedBy: user.id,
        decidedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      });
      // per-size links ALREADY synced (nothing to send for them)
      await db.insert(pairingVariantLinks).values([
        { code: "FS/S", url: "https://x.example/S", updatedAt: new Date("2026-01-01T00:00:00Z"), syncedAt: new Date("2026-01-02T00:00:00Z") },
        { code: "FS/M", url: "https://x.example/M", updatedAt: new Date("2026-01-01T00:00:00Z"), syncedAt: new Date("2026-01-02T00:00:00Z") },
      ]);
      // a CHANGED (never-synced) product-level override that is now dormant —
      // all its variants are split-governed, so nothing to upload for it
      await db
        .insert(productSupplierLinkOverrides)
        .values({ productKey: "FS", url: "https://x.example/dormant", updatedAt: new Date("2026-01-03T00:00:00Z") });

      const result = await runShoptetWriteback(db, fixtureConfig(), new Date("2026-02-01T00:00:00Z"));
      // nothing to upload — but the dormant override MUST have been marked
      expect(result).toEqual({ status: "nothing_changed" });
      expect(fixture.logEntryCount()).toBe(1); // no import happened (only the seed)

      const [row] = await db
        .select({ syncedAt: productSupplierLinkOverrides.syncedAt })
        .from(productSupplierLinkOverrides)
        .where(eq(productSupplierLinkOverrides.productKey, "FS"));
      expect(row?.syncedAt?.toISOString()).toBe("2026-02-01T00:00:00.000Z");

      // second run: it does NOT re-select the now-marked dormant override
      const second = await runShoptetWriteback(db, fixtureConfig(), new Date("2026-02-02T00:00:00Z"));
      expect(second).toEqual({ status: "nothing_changed" });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "on a hard Shoptet failure leaves syncedAt untouched, so the same product is retried next run",
    async () => {
      await insertTestVariantForProduct(db, "P2", "P2", {});
      await db
        .insert(productSupplierLinkOverrides)
        .values({ productKey: "P2", url: "https://x.example/p2", updatedAt: new Date("2026-01-01T00:00:00Z") });
      fixture.setOutcome("hard-error");

      const result = await runShoptetWriteback(db, fixtureConfig(), new Date("2026-02-01T00:00:00Z"));
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.errorDetail).toContain("Data in column code are not unique");
      }

      const [row] = await db
        .select({ syncedAt: productSupplierLinkOverrides.syncedAt })
        .from(productSupplierLinkOverrides)
        .where(eq(productSupplierLinkOverrides.productKey, "P2"));
      expect(row?.syncedAt).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "issue 465: a product with a variant missing from Shoptet no longer poisons the batch — a healthy sibling override still syncs",
    async () => {
      // Reproduces the prod incident exactly (job_run link.failed:1 for 173
      // runs): product POISON has a dead code (variant removed from Shoptet),
      // healthy sibling HEALTHY is stuck in the same all-or-nothing batch.
      await insertTestVariantForProduct(db, "POISON", "POISON/LIVE", { pairCode: "1670" });
      await insertTestVariantForProduct(db, "POISON", "POISON/DEAD", {
        pairCode: "1670",
        missingSince: new Date("2026-08-13T09:22:02Z"),
      });
      await db
        .insert(productSupplierLinkOverrides)
        .values({ productKey: "POISON", url: "https://x.example/poison", updatedAt: new Date("2026-01-01T00:00:00Z") });

      await insertTestVariantForProduct(db, "HEALTHY", "HEALTHY/1", { pairCode: "9" });
      await db
        .insert(productSupplierLinkOverrides)
        .values({ productKey: "HEALTHY", url: "https://x.example/healthy", updatedAt: new Date("2026-01-01T00:00:00Z") });

      // real Shoptet fails the WHOLE batch if the dead code is uploaded
      fixture.failImportWhenCsvContainsCode("POISON/DEAD");

      const result = await runShoptetWriteback(db, fixtureConfig(), new Date("2026-02-01T00:00:00Z"));
      // dead code excluded → 2 live rows (POISON/LIVE + HEALTHY/1), import succeeds
      expect(result).toEqual({ status: "ok", productCount: 2, variantLinkCount: 0, rowCount: 2 });

      // BOTH overrides are marked synced — the healthy sibling is no longer blocked
      const rows = await db
        .select({ productKey: productSupplierLinkOverrides.productKey, syncedAt: productSupplierLinkOverrides.syncedAt })
        .from(productSupplierLinkOverrides);
      const syncedByKey = new Map(rows.map((r) => [r.productKey, r.syncedAt]));
      expect(syncedByKey.get("POISON")?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
      expect(syncedByKey.get("HEALTHY")?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    },
    TEST_TIMEOUT_MS,
  );
});
