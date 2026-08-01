import { and, eq, lte } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orders } from "../../db/schema.js";

/**
 * Označí JEDNU objednávku ako úspešne zapísanú (issue 123) — voláme LEN po
 * POTVRDENOM úspechu (fill + uloženie + čerstvá navigácia potvrdila hodnotu
 * na strane Shoptetu, `order-note-playwright.ts`). Na rozdiel od #122
 * (dávkové označenie na konci CELÉHO behu) sa toto volá PER OBJEDNÁVKA hneď
 * po jej vlastnom úspechu — zápis je tu per-objednávka (nie jeden hromadný
 * CSV import), takže zlyhanie NA JEDNEJ objednávke nesmie stratiť úspech
 * tých pred ňou.
 *
 * `now` je čas ZAČIATKU CELÉHO behu (zachytený PRED výberom,
 * `run-order-note-writeback.ts`) — `commentUpdatedAt <= now` chráni pred
 * pretekaním presne ako #122's `mark-synced.ts`: keby manažér upravil TÚTO
 * ISTÚ poznámku ZNOVA počas behu (Playwright môže bežať desiatky sekúnd až
 * minúty na viac objednávok), tá novšia úprava má `commentUpdatedAt` NUTNE
 * neskôr než `now`, takže sa neoznačí — ďalší beh ju pošle znova.
 */
export async function markOrderNoteSynced(db: Database, orderId: string, now: Date): Promise<void> {
  await db
    .update(orders)
    .set({ commentSyncedAt: now })
    .where(and(eq(orders.id, orderId), lte(orders.commentUpdatedAt, now)));
}
