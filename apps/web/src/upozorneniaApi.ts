import { z } from "zod";

// issue 267: "Eshop → Upozornenia" — zrkadlí `UpozornenieRow`
// (`apps/api/src/modules/upozornenia/queries.ts`).

const rowSchema = z.object({
  id: z.string(),
  type: z.enum(["vlastna_poznamka", "nevyzdvihnuta_zasielka", "vratenie", "vratena_zasielka"]),
  source: z.enum(["vlastne", "appka"]),
  title: z.string(),
  details: z.string(),
  link: z.string().nullable(),
  dueAt: z.string().nullable(),
  postponedUntil: z.string().nullable(),
  seenAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
  status: z.enum(["nove", "otvorene", "odlozene", "vybavene"]),
});
export type UpozornenieRow = z.infer<typeof rowSchema>;
export type UpozornenieStatus = UpozornenieRow["status"];

const listSchema = z.object({ rows: z.array(rowSchema) });
const countSchema = z.object({ count: z.number() });

// issue 283: záložka "Vybavené" — zrkadlí `ResolvedUpozornenieRow`
// (`apps/api/src/modules/upozornenia/queries.ts`).
const resolvedRowSchema = rowSchema.extend({ resolvedByName: z.string().nullable() });
export type ResolvedUpozornenieRow = z.infer<typeof resolvedRowSchema>;
const resolvedListSchema = z.object({ rows: z.array(resolvedRowSchema) });

const returnToOpenResultSchema = z.enum(["returned", "no_op", "collision"]);
export type ReturnToOpenResult = z.infer<typeof returnToOpenResultSchema>;
const returnToOpenSchema = z.object({ result: returnToOpenResultSchema });

export class UpozorneniaUnauthorizedError extends Error {
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
  if (response.status === 401) throw new UpozorneniaUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function fetchUpozornenia(filter: { readonly includeResolved: boolean; readonly includePostponed?: boolean }): Promise<readonly UpozornenieRow[]> {
  const params = new URLSearchParams();
  if (filter.includeResolved) params.set("includeResolved", "true");
  if (filter.includePostponed === true) params.set("includePostponed", "true");
  const qs = params.toString();
  const response = await fetch(`/api/upozornenia${qs === "" ? "" : `?${qs}`}`);
  return listSchema.parse(await readJson(response, "Upozornenia sa nepodarilo načítať")).rows;
}

export async function fetchUpozorneniaCount(): Promise<number> {
  const response = await fetch("/api/upozornenia/count");
  if (response.status === 401) return 0;
  if (!response.ok) return 0;
  return countSchema.parse(await response.json()).count;
}

export async function markUpozorneniaSeen(): Promise<void> {
  const response = await fetch("/api/upozornenia/mark-seen", { method: "POST" });
  if (response.status === 401) throw new UpozorneniaUnauthorizedError();
  await readJson(response, "Označenie ako videné zlyhalo");
}

export interface OwnNoteInput {
  readonly title: string;
  readonly details?: string;
  readonly dueAt?: string | null;
}

export async function createOwnNote(input: OwnNoteInput): Promise<void> {
  const response = await fetch("/api/upozornenia", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await readJson(response, "Upozornenie sa nepodarilo vytvoriť");
}

export async function updateOwnNote(id: string, input: OwnNoteInput): Promise<boolean> {
  const response = await fetch(`/api/upozornenia/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await readJson(response, "Upozornenie sa nepodarilo upraviť")) as { readonly updated: boolean };
  return body.updated;
}

export async function deleteOwnNote(id: string): Promise<void> {
  const response = await fetch(`/api/upozornenia/${encodeURIComponent(id)}`, { method: "DELETE" });
  await readJson(response, "Upozornenie sa nepodarilo zmazať");
}

export async function resolveUpozornenie(id: string): Promise<void> {
  const response = await fetch(`/api/upozornenia/${encodeURIComponent(id)}/resolve`, { method: "POST" });
  await readJson(response, "Označenie ako vybavené zlyhalo");
}

export async function postponeUpozornenie(id: string, until: string): Promise<void> {
  const response = await fetch(`/api/upozornenia/${encodeURIComponent(id)}/postpone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ until }),
  });
  await readJson(response, "Odloženie zlyhalo");
}

export async function cancelPostponeUpozornenie(id: string): Promise<void> {
  const response = await fetch(`/api/upozornenia/${encodeURIComponent(id)}/cancel-postpone`, { method: "POST" });
  await readJson(response, "Zrušenie odloženia zlyhalo");
}

export async function fetchResolvedUpozornenia(): Promise<readonly ResolvedUpozornenieRow[]> {
  const response = await fetch("/api/upozornenia/resolved");
  return resolvedListSchema.parse(await readJson(response, "Vybavené upozornenia sa nepodarilo načítať")).rows;
}

export async function returnUpozornenieToOpen(id: string): Promise<ReturnToOpenResult> {
  const response = await fetch(`/api/upozornenia/${encodeURIComponent(id)}/return-to-open`, { method: "POST" });
  return returnToOpenSchema.parse(await readJson(response, "Vrátenie karty zlyhalo")).result;
}
