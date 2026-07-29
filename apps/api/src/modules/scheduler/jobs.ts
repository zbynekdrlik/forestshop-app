import { cleanupExpiredSessions } from "../auth/sessions.js";
import type { RunIngest } from "../catalog/ingest.js";
import { pruneRawSnapshots } from "../catalog/raw-store.js";
import type { ScheduledJob } from "./types.js";

export const CATALOG_IMPORT_JOB_NAME = "catalog-import";
export const PRUNE_RAW_EXPORTS_JOB_NAME = "prune-raw-exports";
export const SESSION_CLEANUP_JOB_NAME = "session-cleanup";

// Rovnaká hláška ako `catalog-routes.ts`'s 503 pri ručnom importe bez
// nakonfigurovaného SHOPTET_EXPORT_URL — operátor vidí to isté vysvetlenie na
// oboch miestach (ručný pokus aj naplánovaný beh).
const EXPORT_URL_NOT_CONFIGURED = "Import katalógu nie je nakonfigurovaný (chýba SHOPTET_EXPORT_URL)";

/**
 * Nočný import katalógu — volá EXISTUJÚCI `runIngest` (index.ts), nič sa
 * nereimplementuje. Bohatý výsledok (accepted/rejected/duplicate) sa aj tak
 * zapíše do `catalog_snapshot` samotným `ingestCatalog` — tento job_run
 * záznam je len scheduler-úrovňová viditeľnosť navyše ("bežal naozaj dnes v
 * noci?"), nie náhrada. Keď `runIngest` nie je nakonfigurované (chýba
 * SHOPTET_EXPORT_URL), job VYHODÍ — scheduler.ts to odchytí a zapíše ako
 * "failure" s touto správou, namiesto toho, aby beh ticho preskočil bez
 * záznamu.
 */
export function catalogImportJob(runIngest: RunIngest | undefined): ScheduledJob {
  return {
    name: CATALOG_IMPORT_JOB_NAME,
    schedule: { hourUtc: 1, minuteUtc: 0 },
    async run(_db, now) {
      if (runIngest === undefined) throw new Error(EXPORT_URL_NOT_CONFIGURED);
      const result = await runIngest(now);
      return { detail: result };
    },
  };
}

/** Mazanie surových exportov starších než 30 dní — volá existujúci `pruneRawSnapshots`. */
export function pruneRawExportsJob(keepDays = 30): ScheduledJob {
  return {
    name: PRUNE_RAW_EXPORTS_JOB_NAME,
    schedule: { hourUtc: 1, minuteUtc: 15 },
    async run(db, now) {
      const result = await pruneRawSnapshots(db, { keepDays, now });
      return { detail: result };
    },
  };
}

/** Mazanie expirovaných relácií (#3) — `DELETE … WHERE expires_at < now()`. */
export function sessionCleanupJob(): ScheduledJob {
  return {
    name: SESSION_CLEANUP_JOB_NAME,
    schedule: { hourUtc: 1, minuteUtc: 30 },
    async run(db, now) {
      const result = await cleanupExpiredSessions(db, now);
      return { detail: result };
    },
  };
}
