import { cleanupExpiredSessions } from "../auth/sessions.js";
import type { RunIngest } from "../catalog/ingest.js";
import { pruneRawSnapshots } from "../catalog/raw-store.js";
import { ORDERS_EXPORT_URL_NOT_CONFIGURED, type RunOrdersIngest } from "../orders/ingest.js";
import { pruneRawOrders } from "../orders/raw-prune.js";
import type { ScheduledJob } from "./types.js";

export const CATALOG_IMPORT_JOB_NAME = "catalog-import";
export const PRUNE_RAW_EXPORTS_JOB_NAME = "prune-raw-exports";
export const SESSION_CLEANUP_JOB_NAME = "session-cleanup";
export const ORDERS_IMPORT_JOB_NAME = "orders-import";
export const PRUNE_RAW_ORDERS_JOB_NAME = "prune-raw-orders";

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
    schedule: { kind: "daily", hourUtc: 1, minuteUtc: 0 },
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
    schedule: { kind: "daily", hourUtc: 1, minuteUtc: 15 },
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
    schedule: { kind: "daily", hourUtc: 1, minuteUtc: 30 },
    async run(db, now) {
      const result = await cleanupExpiredSessions(db, now);
      return { detail: result };
    },
  };
}

/**
 * Import objednávok (#22, hodinová kadencia od #115) — rovnaký vzor ako
 * `catalogImportJob`, volá EXISTUJÚCI `ingestOrders` (cez `runOrdersIngest`
 * closure z `index.ts`), nič sa nereimplementuje. Žiadny nový advisory lock
 * na tejto úrovni — `ingestOrders` (`orders/ingest.ts`) už berie svoj
 * vlastný (`INGEST_ORDERS_ADVISORY_LOCK_KEY`) vnútri seba, presne ako
 * `catalogImportJob` nepridáva zámok navyše. Keď `SHOPTET_ORDERS_URL` nie je
 * nakonfigurované, job VYHODÍ — `scheduler.ts` to zapíše ako "failure" s
 * touto správou, namiesto toho, aby beh ticho preskočil bez záznamu.
 */
export function ordersImportJob(runOrdersIngest: RunOrdersIngest | undefined): ScheduledJob {
  return {
    name: ORDERS_IMPORT_JOB_NAME,
    // #115 (majiteľ: "sync zo shoptetu ma bezat kazdu hodinu"): predtým raz
    // denne o 01:45 (`kind: "daily"`), teraz KAŽDÚ hodinu o :45 — `isDue()`
    // (`scheduler.ts`) periodizuje `hourly` podľa UTC dňa+hodiny, takže sa v
    // tej istej hodine nezopakuje, ale v ĎALŠEJ hodine áno.
    schedule: { kind: "hourly", minuteUtc: 45 },
    async run(_db, now) {
      if (runOrdersIngest === undefined) throw new Error(ORDERS_EXPORT_URL_NOT_CONFIGURED);
      const result = await runOrdersIngest(now);
      return { detail: result };
    },
  };
}

/**
 * Mazanie surových exportov objednávok starších než `keepDays` (#28) — volá
 * existujúci `pruneRawOrders` (čisto súborová retencia, objednávky nemajú
 * snapshotovú tabuľku, na rozdiel od katalógu). Žiadny DB prístup, teda ani
 * žiadny advisory lock.
 */
export function pruneRawOrdersJob(rawDir: string, keepDays = 30): ScheduledJob {
  return {
    name: PRUNE_RAW_ORDERS_JOB_NAME,
    // Zostáva DENNÁ (nie hodinová) — mazanie starých surových exportov
    // netreba spúšťať častejšie. #115: `ordersImportJob` je odteraz hodinová
    // (:45 každú hodinu), takže tento denný beh o 02:00 sa s ním bude
    // prekrývať KAŽDÝ deň (nie len raz), nie iba pri tomto jednom sedení —
    // neprekáža, `pruneRawOrders` nemá žiadny DB advisory zámok (viď komentár
    // vyššie), takže si nekonkuruje.
    schedule: { kind: "daily", hourUtc: 2, minuteUtc: 0 },
    async run(_db, now) {
      const result = await pruneRawOrders(rawDir, { keepDays, now });
      return { detail: result };
    },
  };
}
