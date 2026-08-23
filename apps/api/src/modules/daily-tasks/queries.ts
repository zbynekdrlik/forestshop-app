import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { dailyTask } from "../../db/schema.js";

export interface DailyTaskRow {
  readonly id: string;
  readonly text: string;
  readonly emoji: string | null;
  readonly doneAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// Vždy filtrované na JEDNÉHO používateľa (nikdy zdieľané, viď design komentár
// na issue 342) a zoradené "najnovšie hore" — jediná os triedenia, vybavené
// úlohy ostávajú na svojom mieste (frontend ich len vizuálne stlmí).
export async function listDailyTasks(db: Database, userId: string): Promise<readonly DailyTaskRow[]> {
  return db
    .select({
      id: dailyTask.id,
      text: dailyTask.text,
      emoji: dailyTask.emoji,
      doneAt: dailyTask.doneAt,
      createdAt: dailyTask.createdAt,
      updatedAt: dailyTask.updatedAt,
    })
    .from(dailyTask)
    .where(eq(dailyTask.userId, userId))
    .orderBy(desc(dailyTask.createdAt));
}

// issue 473: odznak počtu v ľavom menu — počet OTVORENÝCH (bez fajky) úloh
// PRIHLÁSENÉHO používateľa. `COUNT(*) WHERE ...` priamo v SQL (rovnaký vzor ako
// `countActionableUpozornenia`, nie natiahnutie všetkých riadkov a `.length` v
// JS). Úlohy sú SÚKROMNÉ — `user_id` filter na KAŽDOM dopyte, presne ako
// `listDailyTasks` vyššie (viď design komentár na issue 342/473), takže odznak
// nikdy nezapočíta cudzie úlohy. `done_at IS NULL` = ešte nevybavená.
export async function countOpenDailyTasks(db: Database, userId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(dailyTask)
    .where(and(eq(dailyTask.userId, userId), isNull(dailyTask.doneAt)));
  return row?.total ?? 0;
}
