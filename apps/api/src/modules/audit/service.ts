import type { Database } from "../../db/client.js";
import { auditEvents } from "../../db/schema.js";

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

export async function record(db: Database, event: AuditEventInput): Promise<void> {
  await db.insert(auditEvents).values({
    at: event.at,
    actorUserId: event.actorUserId ?? null,
    action: event.action,
    entity: event.entity,
    entityId: event.entityId ?? null,
    data: event.data ?? null,
  });
}
