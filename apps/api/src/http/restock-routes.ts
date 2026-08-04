import { zValidator } from "@hono/zod-validator";
import { desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { jobRuns, restockEvents } from "../db/schema.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import { findFeedStateConflicts } from "../modules/catalog/feed-cross-check.js";
import { MAX_PER_RUN, RESTOCK_JOB_NAME } from "../modules/restock/constants.js";
import { listRestockWaiting, selectRestockCandidates } from "../modules/restock/queries.js";
import type { RestockRunResult, RunRestockOptions } from "../modules/restock/run.js";
import { isRestockEnabled, runRestock, setRestockEnabled } from "../modules/restock/run.js";
import { getLatestJobRun } from "../modules/scheduler/queries.js";
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

async function runAndRecord(db: Database, deps: RestockRunDeps, now: Date): Promise<RestockRunResult> {
  const [inserted] = await db
    .insert(jobRuns)
    .values({ jobName: RESTOCK_JOB_NAME, startedAt: now, status: "running" })
    .returning({ id: jobRuns.id });
  const runId = inserted?.id;
  try {
    const result = await runRestock({ db, now, ...deps });
    if (runId !== undefined) {
      await db
        .update(jobRuns)
        .set({ status: "success", finishedAt: new Date(), detail: result })
        .where(eq(jobRuns.id, runId));
    }
    return result;
  } catch (error) {
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    log.error({ rawErrorMessage }, "Vypredané → Skladom: ručný beh zlyhal");
    if (runId !== undefined) {
      await db
        .update(jobRuns)
        .set({ status: "failure", finishedAt: new Date(), errorMessage: rawErrorMessage })
        .where(eq(jobRuns.id, runId));
    }
    throw error;
  }
}

export function registerRestockRoutes(app: Hono<AppBindings>, db: Database, deps: RestockRunDeps): void {
  app.get("/api/restock", requireUser(db), async (c) => {
    const now = new Date();
    const [enabled, lastRun, candidates, events, feedConflicts] = await Promise.all([
      isRestockEnabled(db),
      getLatestJobRun(db, RESTOCK_JOB_NAME),
      selectRestockCandidates(db, now),
      db.select().from(restockEvents).orderBy(desc(restockEvents.at)).limit(200),
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
      let result: RestockRunResult;
      try {
        result = await runAndRecord(db, deps, now);
      } catch {
        return c.json({ ok: false as const, error: "Beh zlyhal." }, 500);
      }
      await record(db, {
        at: now,
        actorUserId: user.userId,
        action: "restock.run_now",
        entity: "restock_event",
        data: { status: result.status },
      });
      log.info({ actorUserId: user.userId, ...result }, "Vypredané → Skladom: ručný beh");
      return c.json({ ok: true as const, result });
    },
  );
}
