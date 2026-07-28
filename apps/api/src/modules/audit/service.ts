import type { Database } from "../../db/client.js";
import { auditEvents } from "../../db/schema.js";

export interface AuditEventInput {
  readonly actorUserId?: string | undefined;
  readonly action: string;
  readonly entity: string;
  readonly entityId?: string | undefined;
  readonly data?: unknown;
}

export async function record(db: Database, event: AuditEventInput): Promise<void> {
  await db.insert(auditEvents).values({
    actorUserId: event.actorUserId ?? null,
    action: event.action,
    entity: event.entity,
    entityId: event.entityId ?? null,
    data: event.data ?? null,
  });
}
