import { z } from "zod";

const jobRunSchema = z.object({
  jobName: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(["running", "success", "failure"]),
  detail: z.unknown(),
  errorMessage: z.string().nullable(),
});

const listSchema = z.object({ items: z.array(jobRunSchema) });

export type JobRun = z.infer<typeof jobRunSchema>;

/** Relácia medzitým vypršala (401) — rovnaký rozdiel ako `CatalogUnauthorizedError`. */
export class SchedulerUnauthorizedError extends Error {
  constructor() {
    super("Neprihlásený");
  }
}

async function readJson(response: Response, fallback: string): Promise<unknown> {
  if (response.status === 401) throw new SchedulerUnauthorizedError();
  if (!response.ok) throw new Error(fallback);
  return await response.json();
}

export async function fetchJobRuns(): Promise<readonly JobRun[]> {
  const response = await fetch("/api/scheduler/runs");
  const parsed = listSchema.parse(await readJson(response, "Prehľad plánovača sa nepodarilo načítať"));
  return parsed.items;
}
