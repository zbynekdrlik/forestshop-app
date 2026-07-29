import { desc } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { jobRuns } from "../../db/schema.js";

export interface JobRunSummary {
  readonly jobName: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: "running" | "success" | "failure";
  readonly detail: unknown;
  readonly errorMessage: string | null;
}

// `SELECT DISTINCT ON (job_name) … ORDER BY job_name, started_at DESC` —
// jeden riadok na úlohu, vždy jej NAJNOVŠÍ beh. Postgres-špecifické (celý
// projekt beží výlučne na Postgrese, rovnaká voľba ako `pg_advisory_xact_lock`
// inde v repe).
export async function listLatestJobRuns(db: Database): Promise<readonly JobRunSummary[]> {
  const rows = await db
    .selectDistinctOn([jobRuns.jobName], {
      jobName: jobRuns.jobName,
      startedAt: jobRuns.startedAt,
      finishedAt: jobRuns.finishedAt,
      status: jobRuns.status,
      detail: jobRuns.detail,
      errorMessage: jobRuns.errorMessage,
    })
    .from(jobRuns)
    .orderBy(jobRuns.jobName, desc(jobRuns.startedAt));

  return rows.map((row) => ({
    jobName: row.jobName,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
    status: row.status,
    detail: row.detail,
    errorMessage: row.errorMessage,
  }));
}
