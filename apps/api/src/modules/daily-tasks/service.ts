import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { dailyTask } from "../../db/schema.js";

export interface CreateDailyTaskInput {
  readonly userId: string;
  readonly text: string;
  readonly now: Date;
}

export interface DailyTaskWriteResult {
  readonly id: string;
}

// Jediná zapisovacia cesta pre NOVÚ úlohu — rovnaký princíp ako
// `.claude/rules/mail-log.md`/`upozornenia`'s "jediná zapisovacia cesta". Autor
// (`userId`) prichádza zo session (nikdy z tela requestu) a ukladá sa aj v
// ZDIEĽANOM režime (#487) — pri riadku sa zobrazuje ako autor, presne ako pri
// Poznámkach (`note`, #437).
export async function createDailyTask(db: Database, input: CreateDailyTaskInput): Promise<DailyTaskWriteResult> {
  const [row] = await db
    .insert(dailyTask)
    .values({ userId: input.userId, text: input.text, createdAt: input.now, updatedAt: input.now })
    .returning({ id: dailyTask.id });
  if (row === undefined) throw new Error("Vloženie úlohy zlyhalo bez chyby");
  return { id: row.id };
}

export interface UpdateDailyTaskTextInput {
  readonly id: string;
  readonly text: string;
  readonly now: Date;
}

// issue 487: ZDIEĽANÝ zoznam — upraviť/odfajknúť/zmazať smie KTOKOĽVEK
// prihlásený, NIE len autor (rovnako ako `note`/Poznámky, #437). Preto sa tu —
// na rozdiel od pôvodnej súkromnej sémantiky (#342, `and(eq(id), eq(user_id))`) —
// vlastníctvo ZÁMERNE nevynucuje; zápisy kľúčujú len `eq(id)`. Neznámu/už
// zmazanú úlohu vrátia ako `false`, nikdy 4xx (rovnaký "neškodné no-op" princíp
// ako zvyšok appky).
//
// Text a emoji ostávajú ZÁMERNE dve samostatné funkcie/endpointy, nie jeden
// partial-update — zrkadlí to dve samostatné akcie v UI ("upraviť text" /
// "pridať emoji", design komentár na tickete) a vyhýba sa dvojznačnosti
// "kľúč nezadaný vs. zadaný ako null" (`.claude/rules/testing.md`'s vlastná
// past pri `??` defaultoch v testových helperoch — rovnaký princíp, len na
// úrovni HTTP body namiesto testovej funkcie).
export async function updateDailyTaskText(db: Database, input: UpdateDailyTaskTextInput): Promise<boolean> {
  const result = await db
    .update(dailyTask)
    .set({ text: input.text, updatedAt: input.now })
    .where(eq(dailyTask.id, input.id))
    .returning({ id: dailyTask.id });
  return result.length > 0;
}

export interface UpdateDailyTaskEmojiInput {
  readonly id: string;
  // `null` = zmazať emoji (späť na "žiadne").
  readonly emoji: string | null;
  readonly now: Date;
}

export async function updateDailyTaskEmoji(db: Database, input: UpdateDailyTaskEmojiInput): Promise<boolean> {
  const result = await db
    .update(dailyTask)
    .set({ emoji: input.emoji, updatedAt: input.now })
    .where(eq(dailyTask.id, input.id))
    .returning({ id: dailyTask.id });
  return result.length > 0;
}

export interface SetDailyTaskDoneInput {
  readonly id: string;
  readonly done: boolean;
  readonly now: Date;
}

export async function setDailyTaskDone(db: Database, input: SetDailyTaskDoneInput): Promise<boolean> {
  const result = await db
    .update(dailyTask)
    .set({ doneAt: input.done ? input.now : null, updatedAt: input.now })
    .where(eq(dailyTask.id, input.id))
    .returning({ id: dailyTask.id });
  return result.length > 0;
}

export interface DeleteDailyTaskInput {
  readonly id: string;
}

export async function deleteDailyTask(db: Database, input: DeleteDailyTaskInput): Promise<boolean> {
  const result = await db
    .delete(dailyTask)
    .where(eq(dailyTask.id, input.id))
    .returning({ id: dailyTask.id });
  return result.length > 0;
}
