import { count, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { dailyTask } from "../../db/schema.js";
import { users } from "../../db/schema-users.js";

export interface DailyTaskRow {
  readonly id: string;
  readonly text: string;
  readonly emoji: string | null;
  readonly authorUserId: string;
  readonly authorName: string;
  readonly doneAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// issue 487: ZDIEĽANÝ zoznam — žiadny per-user filter (na rozdiel od pôvodnej
// súkromnej sémantiky z #342). Presne ako `note` (Poznámky, #437): INNER JOIN na
// `users` pripojí meno AUTORA, aby ho appka mohla zobraziť pri každej úlohe
// (ticket: „autor sa pri riadku zobrazí, aby bolo jasné, čia úloha je"). `user_id`
// stĺpec OSTÁVA ako autor (zapisuje sa zo session pri create, `service.ts`).
// Zoradené „najnovšie hore" — jediná os triedenia, vybavené úlohy ostávajú na
// svojom mieste (frontend ich len vizuálne stlmí).
export async function listDailyTasks(db: Database): Promise<readonly DailyTaskRow[]> {
  return db
    .select({
      id: dailyTask.id,
      text: dailyTask.text,
      emoji: dailyTask.emoji,
      authorUserId: dailyTask.userId,
      authorName: users.displayName,
      doneAt: dailyTask.doneAt,
      createdAt: dailyTask.createdAt,
      updatedAt: dailyTask.updatedAt,
    })
    .from(dailyTask)
    .innerJoin(users, eq(users.id, dailyTask.userId))
    .orderBy(desc(dailyTask.createdAt));
}

// issue 473 + 487: odznak počtu v ľavom menu — počet OTVORENÝCH (bez fajky) úloh
// VŠETKÝCH účtov (zdieľaný zoznam, #487, nie už len prihláseného používateľa).
// `COUNT(*) WHERE done_at IS NULL` priamo v SQL (rovnaký vzor ako
// `countActionableUpozornenia`, nie natiahnutie všetkých riadkov a `.length` v
// JS). Žiadny per-user filter — badge ukazuje rovnaký počet pre každý účet.
export async function countOpenDailyTasks(db: Database): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(dailyTask)
    .where(isNull(dailyTask.doneAt));
  return row?.total ?? 0;
}
