import { z } from "zod";

// issue 342 + 487: "Dôležité → Úlohy na dnes" — zrkadlí `DailyTaskRow`
// (`apps/api/src/modules/daily-tasks/queries.ts`). Od #487 je zoznam ZDIEĽANÝ,
// takže riadok nesie aj `authorUserId`/`authorName` (JOIN na `users`) — autor sa
// zobrazuje pri každej úlohe (ako pri Poznámkach).

const rowSchema = z.object({
  id: z.string(),
  text: z.string(),
  emoji: z.string().nullable(),
  authorUserId: z.string(),
  authorName: z.string(),
  doneAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DailyTaskRow = z.infer<typeof rowSchema>;

const listSchema = z.object({ rows: z.array(rowSchema) });
const countSchema = z.object({ count: z.number() });

export class DailyTasksUnauthorizedError extends Error {
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
  if (response.status === 401) throw new DailyTasksUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function fetchDailyTasks(): Promise<readonly DailyTaskRow[]> {
  const response = await fetch("/api/daily-tasks");
  return listSchema.parse(await readJson(response, "Úlohy sa nepodarilo načítať")).rows;
}

// issue 473 + 487: odznak počtu v ľavom menu — počet otvorených úloh VŠETKÝCH
// účtov (zdieľané, #487). Rovnaký
// vzor ako `fetchUpozorneniaCount` (`upozorneniaApi.ts`): odznak nie je
// kritický, takže pri 401/chybe vráti 0 namiesto vyhodenia (App.tsx nechá
// odznak na poslednej známej hodnote).
export async function fetchOpenDailyTasksCount(): Promise<number> {
  const response = await fetch("/api/daily-tasks/count");
  if (response.status === 401) return 0;
  if (!response.ok) return 0;
  return countSchema.parse(await response.json()).count;
}

export async function createDailyTask(text: string): Promise<void> {
  const response = await fetch("/api/daily-tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  await readJson(response, "Úlohu sa nepodarilo pridať");
}

export async function updateDailyTaskText(id: string, text: string): Promise<boolean> {
  const response = await fetch(`/api/daily-tasks/${encodeURIComponent(id)}/text`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = (await readJson(response, "Text sa nepodarilo upraviť")) as { readonly updated: boolean };
  return body.updated;
}

export async function updateDailyTaskEmoji(id: string, emoji: string | null): Promise<boolean> {
  const response = await fetch(`/api/daily-tasks/${encodeURIComponent(id)}/emoji`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emoji }),
  });
  const body = (await readJson(response, "Emoji sa nepodarilo uložiť")) as { readonly updated: boolean };
  return body.updated;
}

export async function setDailyTaskDone(id: string, done: boolean): Promise<boolean> {
  const response = await fetch(`/api/daily-tasks/${encodeURIComponent(id)}/done`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ done }),
  });
  const body = (await readJson(response, "Označenie zlyhalo")) as { readonly updated: boolean };
  return body.updated;
}

export async function deleteDailyTask(id: string): Promise<void> {
  const response = await fetch(`/api/daily-tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
  await readJson(response, "Úlohu sa nepodarilo odstrániť");
}
