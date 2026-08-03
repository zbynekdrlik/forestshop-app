import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Database } from "../db/client.js";
import { jobRuns } from "../db/schema.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import { getLatestJobRun } from "../modules/scheduler/queries.js";
import { SUPPLIER_STOCK_JOB_NAME } from "../modules/supplier-stock/constants.js";
import type { PageFetcher } from "../modules/supplier-stock/page-fetcher.js";
import {
  getSupplierStockOverview,
  listSupplierStock,
  listUnreadableHosts,
} from "../modules/supplier-stock/queries.js";
import type { SupplierStockRunResult } from "../modules/supplier-stock/run.js";
import { runSupplierStock } from "../modules/supplier-stock/run.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

function isRunResult(detail: unknown): detail is SupplierStockRunResult {
  return typeof detail === "object" && detail !== null && "checked" in detail;
}

/**
 * Manuálny beh zapisuje `job_run` tým istým tvarom ako scheduler, aby
 * obrazovka videla ručné spustenie HNEĎ (rovnaký vzor a rovnaký dôvod ako
 * `posta-uncollected-routes.ts`'s `runAndRecord` — `executeJob` nie je
 * exportované).
 */
async function runAndRecord(
  db: Database,
  fetchPage: PageFetcher,
  now: Date,
): Promise<SupplierStockRunResult> {
  const [inserted] = await db
    .insert(jobRuns)
    .values({ jobName: SUPPLIER_STOCK_JOB_NAME, startedAt: now, status: "running" })
    .returning({ id: jobRuns.id });
  const runId = inserted?.id;
  try {
    const result = await runSupplierStock({ db, now, fetchPage });
    if (runId !== undefined) {
      await db
        .update(jobRuns)
        .set({ status: "success", finishedAt: new Date(), detail: result })
        .where(eq(jobRuns.id, runId));
    }
    return result;
  } catch (error) {
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    log.error({ rawErrorMessage }, "Dodávateľský sklad: ručný beh zlyhal");
    if (runId !== undefined) {
      await db
        .update(jobRuns)
        .set({ status: "failure", finishedAt: new Date(), errorMessage: rawErrorMessage })
        .where(eq(jobRuns.id, runId));
    }
    throw error;
  }
}

export function registerSupplierStockRoutes(
  app: Hono<AppBindings>,
  db: Database,
  fetchPage: PageFetcher,
): void {
  // Čítanie — každý prihlásený zamestnanec. Scraper nemá Štart/Stop prepínač:
  // nikam nezapisuje (len GET-y na stránky dodávateľov), takže nie je pred
  // čím chrániť. Prepínač má AŽ automatizácia, ktorá na základe týchto dát
  // zapisuje do Shoptetu (issue 213).
  app.get("/api/supplier-stock", requireUser(db), async (c) => {
    const [overview, rows, unreadable, lastRun] = await Promise.all([
      getSupplierStockOverview(db),
      listSupplierStock(db),
      listUnreadableHosts(db),
      getLatestJobRun(db, SUPPLIER_STOCK_JOB_NAME),
    ]);
    return c.json({
      overview,
      rows,
      unreadable,
      lastRun:
        lastRun === null
          ? null
          : {
              startedAt: lastRun.startedAt,
              finishedAt: lastRun.finishedAt,
              status: lastRun.status,
              errorMessage: lastRun.errorMessage,
              result: isRunResult(lastRun.detail) ? lastRun.detail : null,
            },
    });
  });

  app.post(
    "/api/supplier-stock/run-now",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    async (c) => {
      const user = c.get("user");
      const now = new Date();
      let result: SupplierStockRunResult;
      try {
        result = await runAndRecord(db, fetchPage, now);
      } catch {
        // Presné znenie chyby je už v logu aj v `job_run` — používateľovi sa
        // vracia len to, že beh zlyhal (rovnako ako ostatné "Spustiť teraz").
        return c.json({ ok: false as const, error: "Beh zlyhal." }, 500);
      }
      await record(db, {
        at: now,
        actorUserId: user.userId,
        action: "supplier_stock.run_now",
        entity: "supplier_stock",
        data: { checked: result.checked, failed: result.failed },
      });
      log.info({ actorUserId: user.userId, ...result }, "Dodávateľský sklad: ručný beh");
      return c.json({ ok: true as const, result });
    },
  );
}
