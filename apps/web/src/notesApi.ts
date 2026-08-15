import { z } from "zod";

// issue 437: "Poznámky" — ZDIEĽANÁ nástenka. Zrkadlí `NoteRow`
// (`apps/api/src/modules/note/queries.ts`) — vrátane `authorName` (JOIN na
// `users`), keďže poznámky sú zdieľané a autor sa zobrazuje.

const rowSchema = z.object({
  id: z.string(),
  body: z.string(),
  authorUserId: z.string(),
  authorName: z.string(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type NoteRow = z.infer<typeof rowSchema>;

const listSchema = z.object({ rows: z.array(rowSchema) });

export class NotesUnauthorizedError extends Error {
  constructor() {
    super("Neprihlásený");
  }
}

const errorBodySchema = z.object({ error: z.string() });

async function serverErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const parsed = errorBodySchema.safeParse(await response.json());
    if (parsed.success) return parsed.data.error;
  } catch {
    // telo nie je platný JSON — použi všeobecnú hlášku
  }
  return fallback;
}

async function readJson(response: Response, fallback: string): Promise<unknown> {
  if (response.status === 401) throw new NotesUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function fetchNotes(): Promise<readonly NoteRow[]> {
  const response = await fetch("/api/notes");
  return listSchema.parse(await readJson(response, "Poznámky sa nepodarilo načítať")).rows;
}

export async function createNote(body: string): Promise<void> {
  const response = await fetch("/api/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  await readJson(response, "Poznámku sa nepodarilo uložiť");
}

export async function setNoteResolved(id: string, resolved: boolean): Promise<boolean> {
  const response = await fetch(`/api/notes/${encodeURIComponent(id)}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resolved }),
  });
  const body = (await readJson(response, "Označenie zlyhalo")) as { readonly updated: boolean };
  return body.updated;
}

export async function deleteNote(id: string): Promise<void> {
  const response = await fetch(`/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
  await readJson(response, "Poznámku sa nepodarilo odstrániť");
}
