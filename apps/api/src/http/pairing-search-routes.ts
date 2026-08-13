// issue 387 E3: HTTP vrstva pre gather beh. Návrh (sekcia 2) menuje "POST
// run-now, GET status" — `PUT /enabled` je pridané nad rámec tohto zoznamu,
// aby `enabled` (Štart/Stop, default vypnuté) malo VÔBEC nejakú cestu na
// "ručné zapnutie" (design komentár na tickete, "Menšie odchýlky"): presne
// ten istý vzor majú VŠETKY tri existujúce automatizácie v appke
// (`restock-routes.ts`, `posta-uncollected-routes.ts`,
// `order-reminder-routes.ts`).

import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import { PAIRING_SEARCH_JOB_NAME, PAIRING_SEARCH_RUN_LOCK_KEY } from "../modules/pairing-search/constants.js";
import type { PairingSearchRunResult } from "../modules/pairing-search/run.js";
import { runPairingSearchLocked } from "../modules/pairing-search/run.js";
import { isPairingSearchEnabled, setPairingSearchEnabled } from "../modules/pairing-search/settings.js";
import { getLatestJobRun } from "../modules/scheduler/queries.js";
import { startRunNow, type RunNowStart } from "../modules/scheduler/run-now.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

const setEnabledBody = z.object({ enabled: z.boolean() });

function isRunResult(detail: unknown): detail is PairingSearchRunResult {
  return typeof detail === "object" && detail !== null && "eligible" in detail;
}

// issue 413: manuálne "Spustiť teraz" ide odteraz cez ZDIEĽANÝ `startRunNow`
// (`modules/scheduler/run-now.ts`) — pôvodný komentár tu (nižšie citovaný v
// design komentári na tikete) výslovne dokumentoval SYNCHRÓNNE ako zámerné,
// zdieľané správanie naprieč VŠETKÝMI šiestimi automatizáciami po prvom
// ostrom ~21-min behu (issue 387) — presne preto sa teraz menia VŠETKÝCH
// šesť naraz, jedným zdieľaným mechanizmom, nikdy len táto trasa osamote.
// `GET /api/pairing-search/status` vidí manuálny beh HNEĎ AKO ZAČAL (status
// "running"), nielen po dobehnutí.

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
      let outcome: RunNowStart;
      try {
        outcome = await startRunNow(
          db,
          {
            jobName: PAIRING_SEARCH_JOB_NAME,
            lockKey: PAIRING_SEARCH_RUN_LOCK_KEY,
            run: (runNow) => runPairingSearchLocked({ db, now: runNow }),
          },
          now,
          async (settled) => {
            if (settled.status !== "success") return;
            const { result } = settled;
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
          },
        );
      } catch {
        return c.json({ ok: false as const, error: "Beh sa nepodarilo spustiť." }, 500);
      }
      if (outcome.status === "busy") return c.json({ ok: false as const, error: outcome.message }, 200);
      return c.json({ ok: true as const, started: true as const }, 202);
    },
  );
}
