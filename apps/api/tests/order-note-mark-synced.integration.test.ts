import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { orders } from "../src/db/schema.js";
import { DEFAULT_ORDER_OPEN_STATUS } from "../src/modules/orders/open-statuses.js";
import { markOrderNoteSynced } from "../src/modules/shoptet-writeback/order-note-mark-synced.js";
import { withCleanDb } from "./helpers/db.js";

async function insertOrder(db: Database, overrides: Partial<typeof orders.$inferInsert> & { externalOrderId: string }) {
  const [row] = await db
    .insert(orders)
    .values({
      customerName: "Zákazník",
      statusName: DEFAULT_ORDER_OPEN_STATUS,
      placedAt: new Date("2026-01-01T00:00:00Z"),
      ...overrides,
    })
    .returning({ id: orders.id });
  if (row === undefined) throw new Error("testovacia objednávka sa nepodarilo vložiť");
  return row.id;
}

describe("markOrderNoteSynced", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await withCleanDb());
  });

  afterEach(async () => {
    await close();
  });

  it("sets commentSyncedAt to `now` after a confirmed successful write", async () => {
    const orderId = await insertOrder(db, {
      externalOrderId: "2001",
      shoptetOrderId: 111,
      comment: "Zavolať",
      commentUpdatedAt: new Date("2026-01-02T00:00:00Z"),
    });

    const now = new Date("2026-01-02T00:05:00Z");
    await markOrderNoteSynced(db, orderId, now);

    const [after] = await db.select({ syncedAt: orders.commentSyncedAt }).from(orders).where(eq(orders.id, orderId));
    expect(after?.syncedAt?.toISOString()).toBe(now.toISOString());
  });

  it("does NOT mark synced when the comment was edited AGAIN after `now` (race during a long-running Playwright run)", async () => {
    const runStartedAt = new Date("2026-01-02T00:00:00Z");
    const orderId = await insertOrder(db, {
      externalOrderId: "2002",
      shoptetOrderId: 222,
      comment: "Poznámka upravená POČAS behu",
      // updatedAt je NESKÔR než `now` odovzdané do markOrderNoteSynced —
      // simuluje manažérovu úpravu tesne PO tom, čo select-changes prečítal
      // starú hodnotu, ale PRED tým, než Playwright stihol dobehnúť.
      commentUpdatedAt: new Date("2026-01-02T00:10:00Z"),
    });

    await markOrderNoteSynced(db, orderId, runStartedAt);

    const [after] = await db.select({ syncedAt: orders.commentSyncedAt }).from(orders).where(eq(orders.id, orderId));
    expect(after?.syncedAt).toBeNull();
  });

  it("is a no-op for an unknown orderId (never throws)", async () => {
    await expect(markOrderNoteSynced(db, "00000000-0000-0000-0000-000000000000", new Date())).resolves.toBeUndefined();
  });
});
