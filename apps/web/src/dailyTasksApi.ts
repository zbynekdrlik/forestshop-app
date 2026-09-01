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
  // issue 519: hlasová poznámka. `hasAudio` = riadok má nahrávku (streamuje sa
  // z `dailyTaskAudioUrl`); `audioDurationMs` sa nesie pre zobrazenie dĺžky.
  hasAudio: z.boolean(),
  audioDurationMs: z.number().nullable(),
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

// issue 519: nahranie hlasovej poznámky (multipart). `durationMs` je z
// klientskeho časovača (nepovinné). Server ju prepíše (Whisper) alebo uloží
// audio-only pri zlyhaní — nikdy sa nestratí nahrávka. `Content-Type` sa
// NENASTAVUJE ručne — `fetch` s `FormData` doplní `multipart/form-data` s
// hranicou sám.
export async function createVoiceDailyTask(audio: Blob, mime: string, durationMs: number | null): Promise<void> {
  const form = new FormData();
  form.append("audio", audio, `hlasova-poznamka.${mime.includes("mp4") ? "m4a" : "webm"}`);
  if (durationMs !== null) form.append("durationMs", String(durationMs));
  const response = await fetch("/api/daily-tasks/voice", { method: "POST", body: form });
  await readJson(response, "Hlasovú poznámku sa nepodarilo uložiť");
}

// issue 519: URL na streamovanie nahrávky konkrétnej úlohy.
export function dailyTaskAudioUrl(id: string): string {
  return `/api/daily-tasks/${encodeURIComponent(id)}/audio`;
}

// issue 519: „potom sa dá odkaz vymazať" — zmaže LEN nahrávku, úlohu nechá.
export async function deleteDailyTaskAudio(id: string): Promise<boolean> {
  const response = await fetch(`/api/daily-tasks/${encodeURIComponent(id)}/audio`, { method: "DELETE" });
  const body = (await readJson(response, "Nahrávku sa nepodarilo odstrániť")) as { readonly updated: boolean };
  return body.updated;
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
