import { desc, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { note } from "../../db/schema-note.js";
import { users } from "../../db/schema-users.js";

export interface NoteRow {
  readonly id: string;
  readonly body: string;
  readonly authorUserId: string;
  readonly authorName: string;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ZDIEĽANÝ zoznam — žiadny per-user filter (na rozdiel od `daily-tasks/
// queries.ts`, ktorý filtruje na `userId`). JOIN na `users` pripojí meno
// autora, aby ho appka mohla zobraziť pri každej poznámke (ticket: „autor je
// zobrazený"). Zoradené „najnovšie hore" — jediná os triedenia, vybavené
// poznámky ostávajú na svojom mieste (frontend ich len vizuálne stlmí).
export async function listNotes(db: Database): Promise<readonly NoteRow[]> {
  return db
    .select({
      id: note.id,
      body: note.body,
      authorUserId: note.authorUserId,
      authorName: users.displayName,
      resolvedAt: note.resolvedAt,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    })
    .from(note)
    .innerJoin(users, eq(users.id, note.authorUserId))
    .orderBy(desc(note.createdAt));
}
