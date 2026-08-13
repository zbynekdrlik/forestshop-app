// issue 402: HTTP vrstva pre `shop-sitemap` beh — LEN `GET /status` +
// `POST /run-now` (rovnaký vzor ako `pairing-search-routes.ts`, bez
// Štart/Stop prepínača — job nikdy nezapisuje do živého e-shopu, žiadny
// dôvod ho vypínať). Žiadne VLASTNÉ frontend tlačidlo v tomto tickete
// (design komentár na tickete) — trasa slúži pre ops/smoke-test/budúce UI,
// rovnaké zdôvodnenie ako `shop-feed`u chýbajúci manuálny spúšťač úplne.

import type { Hono } from "hono";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import { SHOP_SITEMAP_JOB_NAME, SHOP_SITEMAP_RUN_LOCK_KEY } from "../modules/shop-sitemap/constants.js";
import { runShopSitemapLocked, type ShopSitemapRunResult } from "../modules/shop-sitemap/run.js";
import { getLatestJobRun } from "../modules/scheduler/queries.js";
import { startRunNow, type RunNowStart } from "../modules/scheduler/run-now.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

function isRunResult(detail: unknown): detail is ShopSitemapRunResult {
  return typeof detail === "object" && detail !== null && "missingProducts" in detail;
}

// issue 413: manuálne "Spustiť teraz" ide cez zdieľaný `startRunNow`
// (`modules/scheduler/run-now.ts`) — vloží "running" riadok HNEĎ a vráti
// odpoveď BEZ čakania na celý beh (predtým synchrónne — presne TENTO job
// bol nálezom (a) na tikete: druhý beh 08:55 aj 09:01 z Cloudflare retry).

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
    let outcome: RunNowStart;
    try {
      outcome = await startRunNow(
        db,
        {
          jobName: SHOP_SITEMAP_JOB_NAME,
          lockKey: SHOP_SITEMAP_RUN_LOCK_KEY,
          run: (runNow) => runShopSitemapLocked({ db, now: runNow }),
        },
        now,
        async (settled) => {
          if (settled.status !== "success") return;
          const { result } = settled;
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
        },
      );
    } catch {
      return c.json({ ok: false as const, error: "Beh sa nepodarilo spustiť." }, 500);
    }
    if (outcome.status === "busy") return c.json({ ok: false as const, error: outcome.message }, 200);
    return c.json({ ok: true as const, started: true as const }, 202);
  });
}
