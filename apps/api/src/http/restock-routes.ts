import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import { findFeedStateConflicts } from "../modules/catalog/feed-cross-check.js";
import { MAX_PER_RUN, RESTOCK_JOB_NAME, RESTOCK_RUN_LOCK_KEY } from "../modules/restock/constants.js";
import { listRestockEvents, listRestockWaiting, selectRestockCandidates } from "../modules/restock/queries.js";
import type { RestockRunResult, RunRestockOptions } from "../modules/restock/run.js";
import { isRestockEnabled, runRestockLocked, setRestockEnabled } from "../modules/restock/run.js";
import { getLatestJobRun } from "../modules/scheduler/queries.js";
import { startRunNow, type RunNowStart } from "../modules/scheduler/run-now.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

const setEnabledBody = z.object({ enabled: z.boolean() });

// Strop stránky drží odpoveď v rozumnej veľkosti aj keď si niekto adresu
// upraví ručne — kandidátov sú tisíce.
const waitingQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  supplier: z.string().max(200).optional(),
});

// HTTP vrstva dodá `db`/`now`; zvyšok (prihlasovacie údaje do Shoptetu)
// zostavuje `index.ts` raz pri štarte — rovnaký vzor ako ostatné automatizácie.
export type RestockRunDeps = Omit<RunRestockOptions, "db" | "now">;

function isRunResult(detail: unknown): detail is RestockRunResult {
  return typeof detail === "object" && detail !== null && "status" in detail;
}

// issue 413: manuálne "Spustiť teraz" ide cez zdieľaný `startRunNow`
// (`modules/scheduler/run-now.ts`) — vloží "running" riadok HNEĎ a vráti
// odpoveď BEZ čakania na celý beh, viď design komentár na tikete.

export function registerRestockRoutes(app: Hono<AppBindings>, db: Database, deps: RestockRunDeps): void {
  app.get("/api/restock", requireUser(db), async (c) => {
    const now = new Date();
    const [enabled, lastRun, candidates, events, feedConflicts] = await Promise.all([
      isRestockEnabled(db),
      getLatestJobRun(db, RESTOCK_JOB_NAME),
      selectRestockCandidates(db, now),
      listRestockEvents(db, 200),
      // issue 226: krížová kontrola nášho stavu proti Shoptetovmu feedu —
      // varovanie s číslom a zoznamom priamo na tejto obrazovke, nikdy len
      // tichý zápis do logu.
      findFeedStateConflicts(db),
    ]);
    return c.json({
      enabled,
      maxPerRun: MAX_PER_RUN,
      // Koľko by sa prepol NAJBLIŽŠÍ beh — majiteľ tak vidí dopredu, čo ho
      // čaká, nielen čo sa už stalo.
      waiting: { now: candidates.picked.length, overLimit: candidates.overLimit },
      feedConflicts,
      events,
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

  // Overovací zoznam (issue 217) — majiteľ si chce vzorku ručne preklikať skôr,
  // než automatizáciu pustí. Literál `/waiting` nemá pod `/api/restock` žiadneho
  // `:param` súrodenca, takže poradie registrácie tu nič nerozbíja
  // (`.claude/rules/http-routes.md`).
  app.get("/api/restock/waiting", requireUser(db), zValidator("query", waitingQuery), async (c) => {
    const { limit, offset, supplier } = c.req.valid("query");
    const page = await listRestockWaiting(db, new Date(), {
      limit,
      offset,
      ...(supplier === undefined || supplier === "" ? {} : { supplier }),
    });
    return c.json(page);
  });

  // Štart/Stop gate-uje LEN naplánovaný nočný beh (`scheduler/jobs.ts`'s
  // `restockJob`), nikdy "Spustiť teraz" nižšie — explicitná ľudská akcia,
  // rovnaká úvaha ako pri ostatných automatizáciách.
  app.put(
    "/api/restock/enabled",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", setEnabledBody),
    async (c) => {
      const { enabled } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();
      await setRestockEnabled(db, enabled, now);
      await record(db, {
        at: now,
        actorUserId: user.userId,
        action: "restock.enabled.set",
        entity: "restock_settings",
        data: { enabled },
      });
      log.info({ actorUserId: user.userId, enabled }, "Vypredané → Skladom: Štart/Stop");
      return c.json({ ok: true as const, enabled });
    },
  );

  app.post(
    "/api/restock/run-now",
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
            jobName: RESTOCK_JOB_NAME,
            lockKey: RESTOCK_RUN_LOCK_KEY,
            run: (runNow) => runRestockLocked({ db, now: runNow, ...deps }),
          },
          now,
          async (settled) => {
            if (settled.status !== "success") return;
            await record(db, {
              at: now,
              actorUserId: user.userId,
              action: "restock.run_now",
              entity: "restock_event",
              data: { status: settled.result.status },
            });
            log.info({ actorUserId: user.userId, ...settled.result }, "Vypredané → Skladom: ručný beh");
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
