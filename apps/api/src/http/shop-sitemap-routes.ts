// issue 402: HTTP vrstva pre `shop-sitemap` beh — LEN `GET /status` +
// `POST /run-now` (rovnaký vzor ako `pairing-search-routes.ts`, bez
// Štart/Stop prepínača — job nikdy nezapisuje do živého e-shopu, žiadny
// dôvod ho vypínať). Žiadne VLASTNÉ frontend tlačidlo v tomto tickete
// (design komentár na tickete) — trasa slúži pre ops/smoke-test/budúce UI,
// rovnaké zdôvodnenie ako `shop-feed`u chýbajúci manuálny spúšťač úplne.

import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Database } from "../db/client.js";
import { jobRuns } from "../db/schema.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import { SHOP_SITEMAP_JOB_NAME } from "../modules/shop-sitemap/constants.js";
import { runShopSitemap, type ShopSitemapRunResult } from "../modules/shop-sitemap/run.js";
import { getLatestJobRun } from "../modules/scheduler/queries.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

function isRunResult(detail: unknown): detail is ShopSitemapRunResult {
  return typeof detail === "object" && detail !== null && "missingProducts" in detail;
}

/**
 * Manuálne "Spustiť teraz" zapisuje `job_run` TÝM ISTÝM vzorom ako
 * `scheduler.ts`'s interná `executeJob` (rovnaká kópia ako `pairing-search-
 * routes.ts`'s `runAndRecord`) — SYNCHRÓNNE zámerne, rovnaký dôvod
 * zdokumentovaný tam (appka nemá v sebe žiadny fire-and-forget vzor pre
 * run-now trasy).
 */
async function runAndRecord(db: Database, now: Date): Promise<ShopSitemapRunResult> {
  const [inserted] = await db.insert(jobRuns).values({ jobName: SHOP_SITEMAP_JOB_NAME, startedAt: now, status: "running" }).returning({ id: jobRuns.id });
  const runId = inserted?.id;
  try {
    const result = await runShopSitemap({ db, now });
    if (runId !== undefined) {
      await db.update(jobRuns).set({ status: "success", finishedAt: new Date(), detail: result }).where(eq(jobRuns.id, runId));
    }
    return result;
  } catch (error) {
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    log.error({ rawErrorMessage }, "Adresy z sitemapy: ručný beh zlyhal");
    if (runId !== undefined) {
      await db.update(jobRuns).set({ status: "failure", finishedAt: new Date(), errorMessage: rawErrorMessage }).where(eq(jobRuns.id, runId));
    }
    throw error;
  }
}

export function registerShopSitemapRoutes(app: Hono<AppBindings>, db: Database): void {
  app.get("/api/shop-sitemap/status", requireUser(db), async (c) => {
    const lastRun = await getLatestJobRun(db, SHOP_SITEMAP_JOB_NAME);
    return c.json({
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

  app.post("/api/shop-sitemap/run-now", requireSameOrigin(), requireUser(db), requireRole("admin", "manazer"), async (c) => {
    const user = c.get("user");
    const now = new Date();
    let result: ShopSitemapRunResult;
    try {
      result = await runAndRecord(db, now);
    } catch {
      return c.json({ ok: false as const, error: "Beh zlyhal." }, 500);
    }
    await record(db, {
      at: now,
      actorUserId: user.userId,
      action: "shop_sitemap.run_now",
      entity: "job_run",
      data: {
        missingProducts: result.missingProducts,
        resolvedBySitemap: result.resolvedBySitemap,
        resolvedByProbe: result.resolvedByProbe,
        codesAttempted: result.codesAttempted,
      },
    });
    log.info(
      { actorUserId: user.userId, missingProducts: result.missingProducts, resolvedBySitemap: result.resolvedBySitemap, resolvedByProbe: result.resolvedByProbe },
      "Adresy z sitemapy: ručné spustenie",
    );
    return c.json({ ok: true as const, result });
  });
}
