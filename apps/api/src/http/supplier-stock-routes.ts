import type { Hono } from "hono";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import { getLatestJobRun } from "../modules/scheduler/queries.js";
import { startRunNow, type RunNowStart } from "../modules/scheduler/run-now.js";
import { SUPPLIER_STOCK_JOB_NAME, SUPPLIER_STOCK_RUN_LOCK_KEY } from "../modules/supplier-stock/constants.js";
import type { PageFetcher } from "../modules/supplier-stock/page-fetcher.js";
import {
  getSupplierStockHostOverview,
  getSupplierStockOverview,
  listSupplierStock,
  listUnreadableHosts,
} from "../modules/supplier-stock/queries.js";
import type { SupplierStockRunResult } from "../modules/supplier-stock/run.js";
import { countOwnShopLinks, runSupplierStockLocked } from "../modules/supplier-stock/run.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

function isRunResult(detail: unknown): detail is SupplierStockRunResult {
  return typeof detail === "object" && detail !== null && "checked" in detail;
}

// issue 413: manuálne "Spustiť teraz" ide cez zdieľaný `startRunNow`
// (`modules/scheduler/run-now.ts`) — vloží "running" riadok HNEĎ a vráti
// odpoveď BEZ čakania na celý ~72-minútový beh (predtým synchrónne,
// `.claude/rules/supplier-stock.md`), viď design komentár na tikete.

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
    const [overview, rows, unreadable, hostOverview, ownShopLinksCount, lastRun] = await Promise.all([
      getSupplierStockOverview(db),
      listSupplierStock(db),
      listUnreadableHosts(db),
      getSupplierStockHostOverview(db),
      countOwnShopLinks(db),
      getLatestJobRun(db, SUPPLIER_STOCK_JOB_NAME),
    ]);
    return c.json({
      overview,
      rows,
      unreadable,
      hostOverview,
      ownShopLinksCount,
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
      let outcome: RunNowStart;
      try {
        outcome = await startRunNow(
          db,
          {
            jobName: SUPPLIER_STOCK_JOB_NAME,
            lockKey: SUPPLIER_STOCK_RUN_LOCK_KEY,
            run: (runNow) => runSupplierStockLocked({ db, now: runNow, fetchPage }),
          },
          now,
          async (settled) => {
            if (settled.status !== "success") return;
            await record(db, {
              at: now,
              actorUserId: user.userId,
              action: "supplier_stock.run_now",
              entity: "supplier_stock",
              data: { checked: settled.result.checked, failed: settled.result.failed },
            });
            log.info({ actorUserId: user.userId, ...settled.result }, "Dodávateľský sklad: ručný beh");
          },
        );
      } catch {
        // Presné znenie chyby je už v logu aj v `job_run` — používateľovi sa
        // vracia len to, že beh sa nepodarilo spustiť (rovnako ako ostatné
        // "Spustiť teraz").
        return c.json({ ok: false as const, error: "Beh sa nepodarilo spustiť." }, 500);
      }
      if (outcome.status === "busy") return c.json({ ok: false as const, error: outcome.message }, 200);
      return c.json({ ok: true as const, started: true as const }, 202);
    },
  );
}
