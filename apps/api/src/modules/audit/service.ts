import type { Database } from "../../db/client.js";
import { auditEvents } from "../../db/schema.js";

// `Pick<Database, "insert">` (not the full `Database`) so this also accepts a
// `db.transaction(async (tx) => ...)` callback's `tx` — a `PgTransaction`
// extends the same base class as `NodePgDatabase` and structurally has an
// `insert` of the same shape, but is missing `Database`'s own `$client`
// property (#10, `changePassword` writes its audit row inside the same
// transaction as the password/session updates it's paired with).
export type AuditExecutor = Pick<Database, "insert">;

export interface AuditEventInput {
  readonly actorUserId?: string | undefined;
  readonly action: string;
  readonly entity: string;
  readonly entityId?: string | undefined;
  readonly data?: unknown;
  // Always an explicit input, never read from a global clock (project "now" discipline) —
  // keeps an audit row's timestamp consistent with the session/action it describes and
  // makes time-dependent behavior testable.
  readonly at: Date;
}

export async function record(db: AuditExecutor, event: AuditEventInput): Promise<void> {
  await db.insert(auditEvents).values({
    at: event.at,
    actorUserId: event.actorUserId ?? null,
    action: event.action,
    entity: event.entity,
    entityId: event.entityId ?? null,
    data: event.data ?? null,
  });
}
