// issue 387 E3: HTTP vrstva pre gather beh. Návrh (sekcia 2) menuje "POST
// run-now, GET status" — `PUT /enabled` je pridané nad rámec tohto zoznamu,
// aby `enabled` (Štart/Stop, default vypnuté) malo VÔBEC nejakú cestu na
// "ručné zapnutie" (design komentár na tickete, "Menšie odchýlky"): presne
// ten istý vzor majú VŠETKY tri existujúce automatizácie v appke
// (`restock-routes.ts`, `posta-uncollected-routes.ts`,
// `order-reminder-routes.ts`).

import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { jobRuns } from "../db/schema.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import { PAIRING_SEARCH_JOB_NAME } from "../modules/pairing-search/constants.js";
import type { PairingSearchRunResult } from "../modules/pairing-search/run.js";
import { runPairingSearch } from "../modules/pairing-search/run.js";
import { isPairingSearchEnabled, setPairingSearchEnabled } from "../modules/pairing-search/settings.js";
import { getLatestJobRun } from "../modules/scheduler/queries.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

const setEnabledBody = z.object({ enabled: z.boolean() });

function isRunResult(detail: unknown): detail is PairingSearchRunResult {
  return typeof detail === "object" && detail !== null && "eligible" in detail;
}

/**
 * Manuálne "Spustiť teraz" zapisuje `job_run` TÝM ISTÝM vzorom, aký
 * `scheduler.ts`'s interná `executeJob` používa (rovnaká kópia ako
 * `posta-uncollected-routes.ts`/`restock-routes.ts`'s vlastné
 * `runAndRecord`) — aby `GET /api/pairing-search/status` videl ručný beh
 * HNEĎ, nielen po ďalšom nočnom ticku.
 *
 * SYNCHRÓNNE ZÁMERNE (issue 387, overené po prvom ostrom ~21-min behu):
 * appka NEMÁ v sebe žiadny background/fire-and-forget vzor pre `run-now` —
 * VŠETKY existujúce trasy (`posta-uncollected`, `restock`,
 * `supplier-stock`, `order-reminder`) sú rovnako synchrónne. Cloudflare
 * tunel má vlastný ~100s proxy timeout (`.claude/rules/deploy.md`, issue
 * 227) — dlhý beh cez tunel dostane klientsky HTTP 524, hoci appka beh na
 * `app:3000` dokončí normálne (`job_run` sa zapíše `success`). Toto NIE JE
 * prehliadnutý bug, je to zdieľané, zdokumentované a majiteľom akceptované
 * správanie naprieč VŠETKÝMI päť automatizáciami — never meň LEN túto trasu
 * na async bez toho, aby sa zmenili aj ostatné štyri (inak appka získa dva
 * nekonzistentné vzory naraz).
 */
async function runAndRecord(db: Database, now: Date): Promise<PairingSearchRunResult> {
  const [inserted] = await db
    .insert(jobRuns)
    .values({ jobName: PAIRING_SEARCH_JOB_NAME, startedAt: now, status: "running" })
    .returning({ id: jobRuns.id });
  const runId = inserted?.id;
  try {
    const result = await runPairingSearch({ db, now });
    if (runId !== undefined) {
      await db.update(jobRuns).set({ status: "success", finishedAt: new Date(), detail: result }).where(eq(jobRuns.id, runId));
    }
    return result;
  } catch (error) {
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    log.error({ rawErrorMessage }, "Profesionálne párovanie: ručný beh zlyhal");
    if (runId !== undefined) {
      await db.update(jobRuns).set({ status: "failure", finishedAt: new Date(), errorMessage: rawErrorMessage }).where(eq(jobRuns.id, runId));
    }
    throw error;
  }
}

export function registerPairingSearchRoutes(app: Hono<AppBindings>, db: Database): void {
  app.get("/api/pairing-search/status", requireUser(db), async (c) => {
    const [enabled, lastRun] = await Promise.all([isPairingSearchEnabled(db), getLatestJobRun(db, PAIRING_SEARCH_JOB_NAME)]);
    return c.json({
      enabled,
      lastRun:
        lastRun === null
          ? null
          : {
              startedAt: lastRun.startedAt,
              finishedAt: lastRun.finishedAt,
              status: lastRun.status,
              errorMessage: lastRun.errorMessage,
              result: isRunResult(lastRun.detail) ? lastRun.detail : null,
              skippedReason:
                typeof lastRun.detail === "object" &&
                lastRun.detail !== null &&
                "skipped" in lastRun.detail &&
                (lastRun.detail as { readonly skipped?: unknown }).skipped === true
                  ? ((lastRun.detail as { readonly reason?: unknown }).reason ?? "")
                  : null,
            },
    });
  });

  // Štart/Stop gate-uje LEN naplánovaný nočný beh (`scheduler/jobs.ts`'s
  // `pairingSearchJob`), nikdy "Spustiť teraz" nižšie — rovnaká úvaha ako
  // `restock`/`posta-uncollected`/`order-reminder`.
  app.put(
    "/api/pairing-search/enabled",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", setEnabledBody),
    async (c) => {
      const { enabled } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();
      await setPairingSearchEnabled(db, enabled, now);
      await record(db, {
        at: now,
        actorUserId: user.userId,
        action: "pairing_search.enabled.set",
        entity: "pairing_search_settings",
        data: { enabled },
      });
      log.info({ actorUserId: user.userId, enabled }, "Profesionálne párovanie: Štart/Stop");
      return c.json({ ok: true as const, enabled });
    },
  );

  app.post(
    "/api/pairing-search/run-now",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    async (c) => {
      const user = c.get("user");
      const now = new Date();
      let result: PairingSearchRunResult;
      try {
        result = await runAndRecord(db, now);
      } catch {
        return c.json({ ok: false as const, error: "Beh zlyhal." }, 500);
      }
      await record(db, {
        at: now,
        actorUserId: user.userId,
        action: "pairing_search.run_now",
        entity: "job_run",
        data: {
          eligible: result.eligible,
          processed: result.processed,
          succeeded: result.succeeded,
          failed: result.failed,
        },
      });
      log.info(
        { actorUserId: user.userId, eligible: result.eligible, processed: result.processed, succeeded: result.succeeded, failed: result.failed },
        "Profesionálne párovanie: ručné spustenie",
      );
      return c.json({ ok: true as const, result });
    },
  );
}
