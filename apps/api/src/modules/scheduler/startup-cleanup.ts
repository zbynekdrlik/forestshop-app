import { and, eq, lt } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { jobRuns } from "../../db/schema.js";
import { log } from "../../logger.js";

/**
 * Osirotené `job_run` riadky (issue 413, nález b): reštart appky (nasadenie
 * novej verzie) posiela SIGTERM, `shutdown.ts` zastaví BUDÚCE naplánované
 * ticky, ale UŽ ROZBEHNUTÝ beh (`job.run()`/`runXxx()`) sa NEPRERUŠÍ — proces
 * jednoducho zanikne (`forceExitAfterMs` force-exit po 8 s, alebo Dockerov
 * SIGKILL po `stop_grace_period`), kým `job_run` riadok ostáva navždy
 * `status: "running"`. Nič v appke ho po reštarte nikdy nedohľadá — obrazovka
 * Automatizácie/Plánovač ukazuje "Beží" donekonečna, hoci proces, čo riadok
 * vložil, už dávno neexistuje.
 *
 * `cleanOrphanedJobRuns` sa volá RAZ pri štarte appky (`index.ts`, HNEĎ PO
 * migráciách, PRED `createApp`/`startScheduler`/`serve()`) — v tomto okamihu
 * ešte NIKTO nemohol vložiť NOVÝ "running" riadok (ani HTTP run-now, ani
 * scheduler ešte nebežia), takže žiadny race medzi cleanup-om a čerstvo
 * vloženým riadkom nehrozí. Platí VŠEOBECNE pre KAŽDÝ job (plánovaný aj
 * run-now, nielen tých šesť s manuálnym HTTP triggerom z issue 413) — appka
 * beží vždy ako presne JEDNA inštancia (`.claude/rules/database.md`), takže
 * `status='running'` riadok so `started_at` STARŠÍM než štart TOHOTO procesu
 * patrí nevyhnutne MŔTVEMU procesu, nikdy práve bežiacemu.
 */
export const ORPHANED_JOB_RUN_MESSAGE = "Beh bol prerušený reštartom aplikácie (nasadenie novej verzie) — appka to zistila pri štarte.";

export async function cleanOrphanedJobRuns(db: Database, processStartedAt: Date): Promise<number> {
  const orphaned = await db
    .update(jobRuns)
    .set({ status: "failure", finishedAt: processStartedAt, errorMessage: ORPHANED_JOB_RUN_MESSAGE })
    .where(and(eq(jobRuns.status, "running"), lt(jobRuns.startedAt, processStartedAt)))
    .returning({ id: jobRuns.id, jobName: jobRuns.jobName });

  if (orphaned.length > 0) {
    log.warn(
      { count: orphaned.length, jobNames: orphaned.map((r) => r.jobName) },
      "osirotené job_run riadky (prerušené predošlým reštartom appky) označené ako failure",
    );
  }
  return orphaned.length;
}
