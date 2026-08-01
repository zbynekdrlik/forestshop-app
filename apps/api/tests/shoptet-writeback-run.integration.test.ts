import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { productSupplierLinkOverrides } from "../src/db/schema.js";
import { runShoptetWriteback } from "../src/modules/shoptet-writeback/run-writeback.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariantForProduct } from "./helpers/orders.js";
import { startShoptetFixture, type ShoptetFixture } from "./helpers/shoptet-fixture.js";

const TEST_TIMEOUT_MS = 60_000;

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
      expect(result).toEqual({ status: "ok", productCount: 1, rowCount: 2 });

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
});
