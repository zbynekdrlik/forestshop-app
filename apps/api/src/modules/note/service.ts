import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { note } from "../../db/schema-note.js";

export interface CreateNoteInput {
  readonly authorUserId: string;
  readonly body: string;
  readonly now: Date;
}

export interface NoteWriteResult {
  readonly id: string;
}

// Jediná zapisovacia cesta pre NOVÚ poznámku — rovnaký princíp ako
// `daily-tasks/service.ts`'s „jediná zapisovacia cesta". Autor prichádza zo
// session (`authorUserId`), nikdy z tela requestu.
export async function createNote(db: Database, input: CreateNoteInput): Promise<NoteWriteResult> {
  const [row] = await db
    .insert(note)
    .values({ authorUserId: input.authorUserId, body: input.body, createdAt: input.now, updatedAt: input.now })
    .returning({ id: note.id });
  if (row === undefined) throw new Error("Vloženie poznámky zlyhalo bez chyby");
  return { id: row.id };
}

export interface SetNoteResolvedInput {
  readonly id: string;
  readonly resolved: boolean;
  readonly now: Date;
}

// ZDIEĽANÁ nástenka — vybaviť/vrátiť smie KTOKOĽVEK prihlásený, NIE len autor
// (ticket: „slúžia na spracovanie tímom, nie sú súkromné"). Preto sa tu —
// na rozdiel od `daily-tasks/service.ts`'s `and(eq(id), eq(userId))` —
// vlastníctvo ZÁMERNE nevynucuje. Neznámu/už zmazanú poznámku vráti ako
// `false`, nikdy 4xx (rovnaký „neškodné no-op" princíp ako zvyšok appky).
// `resolvedAt` sa nastaví/zruší jedným atomickým UPDATE, riadok sa nemaže.
export async function setNoteResolved(db: Database, input: SetNoteResolvedInput): Promise<boolean> {
  const result = await db
    .update(note)
    .set({ resolvedAt: input.resolved ? input.now : null, updatedAt: input.now })
    .where(eq(note.id, input.id))
    .returning({ id: note.id });
  return result.length > 0;
}

export interface UpdateNoteTextInput {
  readonly id: string;
  readonly body: string;
  readonly now: Date;
}

// issue 591: oprava textu uloženej poznámky („aby som vedel opraviť čo som
// napísal"). ZDIEĽANÁ nástenka — upraviť smie KTOKOĽVEK prihlásený, rovnako
// ako vybaviť/zmazať (vlastníctvo sa ZÁMERNE nevynucuje). Autor, čas
// vytvorenia aj stav vybavenia ostávajú; mení sa len `body` + `updatedAt`.
// Neznámu/medzitým zmazanú poznámku vráti ako `false` (trasa 200
// `{updated:false}`, UI z toho ukáže „niekto ju zmazal" a obnoví zoznam).
export async function updateNoteText(db: Database, input: UpdateNoteTextInput): Promise<boolean> {
  const result = await db
    .update(note)
    .set({ body: input.body, updatedAt: input.now })
    .where(eq(note.id, input.id))
    .returning({ id: note.id });
  return result.length > 0;
}

export interface DeleteNoteInput {
  readonly id: string;
}

// ZDIEĽANÁ nástenka — zmazať smie KTOKOĽVEK prihlásený (rovnaký dôvod ako
// `setNoteResolved` vyššie). Vlastníctvo sa ZÁMERNE nevynucuje.
export async function deleteNote(db: Database, input: DeleteNoteInput): Promise<boolean> {
  const result = await db.delete(note).where(eq(note.id, input.id)).returning({ id: note.id });
  return result.length > 0;
}
