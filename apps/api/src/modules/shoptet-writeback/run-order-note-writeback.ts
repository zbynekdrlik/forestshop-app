import type { Database } from "../../db/client.js";
import type { OrderNoteWritebackConfig } from "./config.js";
import { markOrderNoteSynced } from "./order-note-mark-synced.js";
import { runOrderNoteWritebackIsolated } from "./order-note-playwright.js";
import { selectChangedOrderNotes } from "./order-note-select.js";

export type OrderNoteWritebackRunResult =
  | { readonly status: "nothing_changed"; readonly skippedCount: number }
  | { readonly status: "ok"; readonly orderCount: number; readonly skippedCount: number }
  | {
      readonly status: "partial";
      readonly orderCount: number;
      readonly succeeded: number;
      readonly failed: number;
      readonly skippedCount: number;
    };

/**
 * Celý beh issue 123: vyber objednávky so zmenenou poznámkou → pre KAŽDÚ
 * zapíš/over cez Playwright → PER OBJEDNÁVKA (nie dávkovo) označ ako
 * synchronizovanú LEN po jej vlastnom potvrdenom úspechu. `now` sa berie ako
 * parameter (ZACHYTENÝ PRED výberom, `scheduler/jobs.ts`) — rovnaká
 * disciplína ako #122's `runShoptetWriteback`, chráni pred pretekaním v
 * `markOrderNoteSynced`.
 */
export async function runOrderNoteWritebackJob(
  db: Database,
  config: OrderNoteWritebackConfig,
  now: Date,
): Promise<OrderNoteWritebackRunResult> {
  const { toSync, skippedCount } = await selectChangedOrderNotes(db);
  if (toSync.length === 0) {
    return { status: "nothing_changed", skippedCount };
  }

  const results = await runOrderNoteWritebackIsolated({ config, orders: toSync });

  let succeeded = 0;
  for (const result of results) {
    if (!result.ok) continue;
    await markOrderNoteSynced(db, result.orderId, now);
    succeeded++;
  }

  const failed = results.length - succeeded;
  if (failed === 0) {
    return { status: "ok", orderCount: succeeded, skippedCount };
  }
  return { status: "partial", orderCount: results.length, succeeded, failed, skippedCount };
}
