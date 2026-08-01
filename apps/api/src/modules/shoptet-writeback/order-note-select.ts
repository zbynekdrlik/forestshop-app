import { and, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orders } from "../../db/schema.js";
import { log } from "../../logger.js";

export interface OrderNoteToSync {
  readonly orderId: string;
  readonly externalOrderId: string;
  /** vždy prítomné — riadky bez neho sú vylúčené (viď `skippedCount` nižšie). */
  readonly shoptetOrderId: number;
  readonly comment: string | null;
}

export interface SelectedOrderNotes {
  readonly toSync: readonly OrderNoteToSync[];
  /** koľko zmenených poznámok appka PRESKOČILA, lebo objednávka (zatiaľ)
   * nemá známe `shoptet_order_id` (žiadny priamy odkaz na detail) — nie
   * chyba, len ešte-nedostupný stav; ďalší beh ich zoberie automaticky
   * hneď, ako sa `shoptet_order_id` doplní (nočný XML fetch, `orders.md`). */
  readonly skippedCount: number;
}

// issue 123: "zmenilo sa niečo od posledného úspešného zápisu?" — presne
// ten istý vzor ako #122's `selectChangedSupplierLinks`, len na
// `order.comment`/`commentUpdatedAt`/`commentSyncedAt` namiesto
// `product_supplier_link_override`. `commentUpdatedAt IS NULL` (nikdy
// zmenené cez appku) sa NEVYBERIE — `changedCondition` vyžaduje neprázdny
// `commentUpdatedAt` implicitne (`lt`/`isNull(syncedAt)` proti stĺpcu, ktorý
// je `null`, nikdy nevyhodnotí `true` v Postgrese), takže nový import bez
// manažérovho zásahu sa nikdy nepokúša synchronizovať.
export async function selectChangedOrderNotes(db: Database): Promise<SelectedOrderNotes> {
  const changedCondition = and(
    isNotNull(orders.commentUpdatedAt),
    or(isNull(orders.commentSyncedAt), lt(orders.commentSyncedAt, orders.commentUpdatedAt)),
  );

  const changed = await db
    .select({
      orderId: orders.id,
      externalOrderId: orders.externalOrderId,
      shoptetOrderId: orders.shoptetOrderId,
      comment: orders.comment,
    })
    .from(orders)
    .where(changedCondition);

  const toSync = changed
    .filter((row): row is typeof row & { shoptetOrderId: number } => row.shoptetOrderId !== null)
    .map((row) => ({
      orderId: row.orderId,
      externalOrderId: row.externalOrderId,
      shoptetOrderId: row.shoptetOrderId,
      comment: row.comment,
    }));
  const skippedCount = changed.length - toSync.length;

  if (skippedCount > 0) {
    log.warn(
      {
        skippedExternalOrderIds: changed
          .filter((row) => row.shoptetOrderId === null)
          .map((row) => row.externalOrderId),
      },
      "spätný zápis poznámky: preskočené zmenené objednávky bez známeho shoptet_order_id (zatiaľ)",
    );
  }

  return { toSync, skippedCount };
}
