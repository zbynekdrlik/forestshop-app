import { inArray, notInArray, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { postaUncollectedState } from "../../db/schema.js";

export interface PostaUncollectedStateRow {
  readonly orderCode: string;
  readonly notifyCount: number;
  readonly lastSentAt: Date | null;
  readonly terminalState: string | null;
  readonly terminalAt: Date | null;
}

function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00Z`);
}

/** Eskalačný stav pre presne tie kódy objednávok, ktoré tento beh potrebuje —
 * chýbajúci riadok = ešte nikdy neevidovaná objednávka (count 0, nikdy
 * neposlané, žiadny terminálny cache). */
export async function loadPostaUncollectedState(
  db: Database,
  orderCodes: readonly string[],
): Promise<ReadonlyMap<string, PostaUncollectedStateRow>> {
  if (orderCodes.length === 0) return new Map();
  const rows = await db
    .select()
    .from(postaUncollectedState)
    .where(inArray(postaUncollectedState.orderCode, [...orderCodes]));
  const out = new Map<string, PostaUncollectedStateRow>();
  for (const row of rows) {
    out.set(row.orderCode, {
      orderCode: row.orderCode,
      notifyCount: row.notifyCount,
      lastSentAt: toDate(row.lastSentAt),
      terminalState: row.terminalState,
      terminalAt: toDate(row.terminalAt),
    });
  }
  return out;
}

export interface PostaUncollectedStateUpdate {
  readonly orderCode: string;
  readonly notifyCount: number;
  readonly lastSentAt: Date | null;
  readonly terminalState: string | null;
  readonly terminalAt: Date | null;
}

export async function upsertPostaUncollectedState(
  db: Database,
  update: PostaUncollectedStateUpdate,
  now: Date,
): Promise<void> {
  const lastSentAt = update.lastSentAt === null ? null : update.lastSentAt.toISOString().slice(0, 10);
  const terminalAt = update.terminalAt === null ? null : update.terminalAt.toISOString().slice(0, 10);
  await db
    .insert(postaUncollectedState)
    .values({
      orderCode: update.orderCode,
      notifyCount: update.notifyCount,
      lastSentAt,
      terminalState: update.terminalState,
      terminalAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: postaUncollectedState.orderCode,
      set: {
        notifyCount: sql`excluded.notify_count`,
        lastSentAt: sql`excluded.last_sent_at`,
        terminalState: sql`excluded.terminal_state`,
        terminalAt: sql`excluded.terminal_at`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

/** Vymaže staré záznamy stavu pre objednávky, ktoré už vypadli z 30-dňového
 * okna (rovnaký zámer ako stará appka's krok "Vyčistí staré záznamy…") —
 * `keepOrderCodes` je presne množina objednávok, ktoré TENTO beh považuje za
 * stále eligible. */
export async function prunePostaUncollectedState(db: Database, keepOrderCodes: readonly string[]): Promise<number> {
  const result =
    keepOrderCodes.length === 0
      ? await db.delete(postaUncollectedState)
      : await db.delete(postaUncollectedState).where(notInArray(postaUncollectedState.orderCode, [...keepOrderCodes]));
  return result.rowCount ?? 0;
}
