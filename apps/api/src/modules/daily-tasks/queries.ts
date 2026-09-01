import { count, desc, eq, isNull, sql } from "drizzle-orm";
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
  // issue 519: `hasAudio` (NIKDY samotné `bytea` v zozname — inak by sa odznak/
  // zoznam nafúkol na megabajty). Nahrávka sa streamuje samostatnou trasou
  // `GET /api/daily-tasks/:id/audio`. `audioDurationMs` (malé číslo) sa nesie
  // pre zobrazenie dĺžky.
  readonly hasAudio: boolean;
  readonly audioDurationMs: number | null;
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
      // Explicitný boolean derivovaný v SQL — `audio` (bytea) sa NIKDY nevyberá.
      hasAudio: sql<boolean>`(${dailyTask.audio} is not null)`,
      audioDurationMs: dailyTask.audioDurationMs,
      createdAt: dailyTask.createdAt,
      updatedAt: dailyTask.updatedAt,
    })
    .from(dailyTask)
    .innerJoin(users, eq(users.id, dailyTask.userId))
    .orderBy(desc(dailyTask.createdAt));
}

// issue 519: nahrávka jednej úlohy na streamovanie (`GET /api/daily-tasks/:id/
// audio`). Vyberá `bytea` + MIME LEN pre tento jeden riadok. `null` = úloha
// neexistuje alebo nemá nahrávku (audio aj mime sa píšu/mažú vždy spolu, ale
// kontrolujeme oba pre istotu).
export interface DailyTaskAudio {
  readonly audio: Buffer;
  readonly mime: string;
}
export async function getDailyTaskAudio(db: Database, id: string): Promise<DailyTaskAudio | null> {
  const [row] = await db
    .select({ audio: dailyTask.audio, mime: dailyTask.audioMime })
    .from(dailyTask)
    .where(eq(dailyTask.id, id));
  if (row === undefined || row.audio === null || row.mime === null) return null;
  return { audio: row.audio, mime: row.mime };
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
