import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { orders } from "../src/db/schema.js";
import { DEFAULT_ORDER_OPEN_STATUS } from "../src/modules/orders/open-statuses.js";
import { selectChangedOrderNotes } from "../src/modules/shoptet-writeback/order-note-select.js";
import { withCleanDb } from "./helpers/db.js";

// issue 123: presne ten istý "zmenilo sa niečo od posledného zápisu?" vzor
// ako #122's shoptet-writeback-select.integration.test.ts, len na
// order.comment/commentUpdatedAt/commentSyncedAt.
describe("selectChangedOrderNotes", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await withCleanDb());
  });

  afterEach(async () => {
    await close();
  });

  async function insertOrder(overrides: Partial<typeof orders.$inferInsert> & { externalOrderId: string }) {
    await db.insert(orders).values({
      customerName: "Zákazník",
      statusName: DEFAULT_ORDER_OPEN_STATUS,
      placedAt: new Date("2026-01-01T00:00:00Z"),
      ...overrides,
    });
  }

  it("returns nothing when no order ever had its comment changed via the app", async () => {
    await insertOrder({ externalOrderId: "1001", shoptetOrderId: 111 });
    const result = await selectChangedOrderNotes(db);
    expect(result.toSync).toEqual([]);
    expect(result.skippedCount).toBe(0);
  });

  it("includes an order whose comment was changed and never synced", async () => {
    await insertOrder({
      externalOrderId: "1002",
      shoptetOrderId: 222,
      comment: "Zavolať zákazníkovi",
      commentUpdatedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result = await selectChangedOrderNotes(db);
    expect(result.toSync).toEqual([
      { orderId: expect.any(String) as string, externalOrderId: "1002", shoptetOrderId: 222, comment: "Zavolať zákazníkovi" },
    ]);
    expect(result.skippedCount).toBe(0);
  });

  it("excludes an order already synced AFTER its last comment change", async () => {
    await insertOrder({
      externalOrderId: "1003",
      shoptetOrderId: 333,
      comment: "Stará poznámka",
      commentUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      commentSyncedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result = await selectChangedOrderNotes(db);
    expect(result.toSync).toEqual([]);
  });

  it("includes an order edited AGAIN after its last successful sync", async () => {
    await insertOrder({
      externalOrderId: "1004",
      shoptetOrderId: 444,
      comment: "Nová poznámka",
      commentUpdatedAt: new Date("2026-01-03T00:00:00Z"),
      commentSyncedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await selectChangedOrderNotes(db);
    expect(result.toSync).toHaveLength(1);
    expect(result.toSync[0]?.comment).toBe("Nová poznámka");
  });

  it("skips (and counts, never crashes on) a changed order without a known shoptet_order_id yet", async () => {
    await insertOrder({
      externalOrderId: "1005",
      shoptetOrderId: null,
      comment: "Zavolať",
      commentUpdatedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result = await selectChangedOrderNotes(db);
    expect(result.toSync).toEqual([]);
    expect(result.skippedCount).toBe(1);
  });

  it("includes a CLEARED comment (commentUpdatedAt set on deletion too) — must remove our block in Shoptet", async () => {
    await insertOrder({
      externalOrderId: "1006",
      shoptetOrderId: 666,
      comment: null,
      commentUpdatedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result = await selectChangedOrderNotes(db);
    expect(result.toSync).toEqual([
      { orderId: expect.any(String) as string, externalOrderId: "1006", shoptetOrderId: 666, comment: null },
    ]);
  });
});
