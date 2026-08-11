import { desc, eq } from "drizzle-orm";
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
