import { inArray, notInArray, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderReminderState } from "../../db/schema.js";

export type OrderReminderResolution = "contacted" | "emailed";
export type OrderReminderResolvedBy = "ai" | "manual";

export interface OrderReminderStateRow {
  readonly orderCode: string;
  readonly fingerprint: string;
  readonly resolution: OrderReminderResolution | null;
  readonly resolvedBy: OrderReminderResolvedBy | null;
  readonly resolvedAt: Date | null;
}

function toResolution(value: string | null): OrderReminderResolution | null {
  return value === "contacted" || value === "emailed" ? value : null;
}

function toResolvedBy(value: string | null): OrderReminderResolvedBy | null {
  return value === "ai" || value === "manual" ? value : null;
}

/** Stav pre presne tie kódy objednávok, ktoré tento beh potrebuje — chýbajúci
 * riadok = ešte nikdy neevidovaná objednávka (nevyriešené, žiadny odtlačok). */
export async function loadOrderReminderState(
  db: Database,
  orderCodes: readonly string[],
): Promise<ReadonlyMap<string, OrderReminderStateRow>> {
  if (orderCodes.length === 0) return new Map();
  const rows = await db
    .select()
    .from(orderReminderState)
    .where(inArray(orderReminderState.orderCode, [...orderCodes]));
  const out = new Map<string, OrderReminderStateRow>();
  for (const row of rows) {
    out.set(row.orderCode, {
      orderCode: row.orderCode,
      fingerprint: row.fingerprint,
      resolution: toResolution(row.resolution),
      resolvedBy: toResolvedBy(row.resolvedBy),
      resolvedAt: row.resolvedAt,
    });
  }
  return out;
}

export async function loadOrderReminderStateOne(db: Database, orderCode: string): Promise<OrderReminderStateRow | null> {
  const map = await loadOrderReminderState(db, [orderCode]);
  return map.get(orderCode) ?? null;
}

export interface OrderReminderStateUpsert {
  readonly orderCode: string;
  readonly fingerprint: string;
  readonly resolution: OrderReminderResolution | null;
  readonly resolvedBy: OrderReminderResolvedBy | null;
  readonly resolvedAt: Date | null;
}

export async function upsertOrderReminderState(db: Database, update: OrderReminderStateUpsert, now: Date): Promise<void> {
  await db
    .insert(orderReminderState)
    .values({
      orderCode: update.orderCode,
      fingerprint: update.fingerprint,
      resolution: update.resolution,
      resolvedBy: update.resolvedBy,
      resolvedAt: update.resolvedAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: orderReminderState.orderCode,
      set: {
        fingerprint: sql`excluded.fingerprint`,
        resolution: sql`excluded.resolution`,
        resolvedBy: sql`excluded.resolved_by`,
        resolvedAt: sql`excluded.resolved_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

/** Vymaže záznamy stavu pre objednávky, ktoré medzičasom opustili nastavené
 * otvorené stavy (vybavené/stornované) — `keepOrderCodes` je presne množina
 * kódov, ktoré TENTO beh považuje za stále eligible (rovnaký zámer ako
 * #172's `prunePostaUncollectedState`). */
export async function pruneOrderReminderState(db: Database, keepOrderCodes: readonly string[]): Promise<number> {
  const result =
    keepOrderCodes.length === 0
      ? await db.delete(orderReminderState)
      : await db.delete(orderReminderState).where(notInArray(orderReminderState.orderCode, [...keepOrderCodes]));
  return result.rowCount ?? 0;
}
