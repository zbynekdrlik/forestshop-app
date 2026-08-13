import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { pairingDecisions, productSupplierLinkOverrides, users } from "../src/db/schema.js";
import { runShoptetWritebackSequence } from "../src/modules/shoptet-writeback/run-writeback-sequence.js";
import { setStateWritebackEnabled } from "../src/modules/shoptet-writeback/state-writeback-settings.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariantForProduct } from "./helpers/orders.js";
import { startShoptetFixture, type ShoptetFixture } from "./helpers/shoptet-fixture.js";

const TEST_TIMEOUT_MS = 60_000;

// issue 387 E7: `runShoptetWritebackSequence` is what the `:50` scheduler
// job now runs — a REAL fixture (not a hand-rolled fake) so both writeback
// paths (linkový + stavový) exercise the exact same Playwright/Log
// attribution machinery a production run does, one after the other against
// the SAME accumulating Log, exactly like production.
describe("runShoptetWritebackSequence (end-to-end proti fixture)", () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let fixture: ShoptetFixture;
  let userId: string;

  beforeEach(async () => {
    ({ db, close: closeDb } = await withCleanDb());
    fixture = await startShoptetFixture({ user: "manager", password: "tajneheslo" });
    fixture.seedPastEntry();
    const [row] = await db
      .insert(users)
      .values({ email: "rozhodca@forestshop.sk", passwordHash: "x", displayName: "Rozhodca", role: "manazer" })
      .returning({ id: users.id });
    if (row === undefined) throw new Error("testovací používateľ sa nepodarilo vložiť");
    userId = row.id;
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
    "state writeback disabled (default) — only the link import runs, state stays 'disabled'",
    async () => {
      const result = await runShoptetWritebackSequence(db, fixtureConfig(), new Date("2026-02-01T00:00:00Z"));
      expect(result).toEqual({ link: { status: "nothing_changed" }, state: { status: "disabled" } });
      expect(fixture.logEntryCount()).toBe(1); // only the seed
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "state writeback enabled — runs BOTH imports as TWO separate uploads against the same Log, and sets stateSyncedAt only on confirmed success",
    async () => {
      await setStateWritebackEnabled(db, true, new Date("2026-01-01T00:00:00Z"));
      await insertTestVariantForProduct(db, "P1", "P1/S", { pairCode: "1" });
      await db
        .insert(productSupplierLinkOverrides)
        .values({ productKey: "P1", url: "https://x.example/p1", updatedAt: new Date("2026-01-01T00:00:00Z") });
      await insertTestVariantForProduct(db, "P2", "P2", {});
      await db.insert(pairingDecisions).values({
        productKey: "P2",
        status: "unavailable",
        url: null,
        decidedBy: userId,
        decidedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      });

      const result = await runShoptetWritebackSequence(db, fixtureConfig(), new Date("2026-02-01T00:00:00Z"));
      expect(result).toEqual({
        link: { status: "ok", productCount: 1, rowCount: 1 },
        state: { status: "ok", productCount: 1, rowCount: 1 },
      });
      // TWO separate uploads happened — one per import, never a combined file.
      expect(fixture.logEntryCount()).toBe(3); // seed + link + state

      const [link] = await db
        .select({ syncedAt: productSupplierLinkOverrides.syncedAt })
        .from(productSupplierLinkOverrides)
        .where(eq(productSupplierLinkOverrides.productKey, "P1"));
      expect(link?.syncedAt?.toISOString()).toBe("2026-02-01T00:00:00.000Z");

      const [decision] = await db.select({ v: pairingDecisions.stateSyncedAt }).from(pairingDecisions).where(eq(pairingDecisions.productKey, "P2"));
      expect(decision?.v?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a hard failure on the LINK import does not block the STATE import from being attempted — the two are independent",
    async () => {
      await setStateWritebackEnabled(db, true, new Date("2026-01-01T00:00:00Z"));
      await insertTestVariantForProduct(db, "P3", "P3", {});
      await db
        .insert(productSupplierLinkOverrides)
        .values({ productKey: "P3", url: "https://x.example/p3", updatedAt: new Date("2026-01-01T00:00:00Z") });
      await insertTestVariantForProduct(db, "P4", "P4", {});
      await db.insert(pairingDecisions).values({
        productKey: "P4",
        status: "discontinued",
        url: null,
        decidedBy: userId,
        decidedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      });
      fixture.setOutcome("hard-error");

      const result = await runShoptetWritebackSequence(db, fixtureConfig(), new Date("2026-02-01T00:00:00Z"));
      expect(result.link.status).toBe("failed");
      expect(result.state.status).toBe("failed");
      // BOTH imports were actually attempted (seed + 2 failed attempts) —
      // the state import was never skipped because the link one failed.
      expect(fixture.logEntryCount()).toBe(3);

      const [link] = await db
        .select({ syncedAt: productSupplierLinkOverrides.syncedAt })
        .from(productSupplierLinkOverrides)
        .where(eq(productSupplierLinkOverrides.productKey, "P3"));
      expect(link?.syncedAt).toBeNull();
      const [decision] = await db.select({ v: pairingDecisions.stateSyncedAt }).from(pairingDecisions).where(eq(pairingDecisions.productKey, "P4"));
      expect(decision?.v).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});
