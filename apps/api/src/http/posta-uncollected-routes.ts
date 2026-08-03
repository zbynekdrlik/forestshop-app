import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { jobRuns } from "../db/schema.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import { MAX_EMAILS } from "../modules/posta-uncollected/constants.js";
import { resolveTemplate } from "../modules/mail-templates/store.js";
import { buildEmail, postaTemplateKey } from "../modules/posta-uncollected/logic.js";
import { POSTA_UNCOLLECTED_JOB_NAME } from "../modules/scheduler/jobs.js";
import { getLatestJobRun } from "../modules/scheduler/queries.js";
import type { PostaUncollectedRunResult, RunPostaUncollectedOptions } from "../modules/posta-uncollected/run.js";
import { runPostaUncollected } from "../modules/posta-uncollected/run.js";
import { isPostaUncollectedEnabled, setPostaUncollectedEnabled } from "../modules/posta-uncollected/settings.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

const setEnabledBody = z.object({ enabled: z.boolean() });
const packageParam = z.object({ packageNumber: z.string().min(1) });

// `Omit<..., "db" | "now">` — HTTP vrstva len dodá `db`/`now`, business
// dependencies (tracking klient, mail transport, BCC adresa, admin base url)
// zostavuje `index.ts` presne raz pri štarte procesu (rovnaký vzor ako
// `runIngest`/`runOrdersIngest`).
export type PostaUncollectedRunDeps = Omit<RunPostaUncollectedOptions, "db" | "now">;

function isRunResult(detail: unknown): detail is PostaUncollectedRunResult {
  return typeof detail === "object" && detail !== null && "uncollected" in detail;
}

/**
 * Manuálne "Spustiť teraz" aj naplánovaný beh zapisujú job_run TÝM ISTÝM
 * vzorom, aký `scheduler.ts`'s `executeJob` používa interne — tá funkcia nie
 * je exportovaná (scheduler-interná), takže táto malá kópia zapisuje
 * rovnaký tvar riadku priamo, aby `GET /api/posta-uncollected` videl
 * manuálny beh HNEĎ, nielen po ďalšom pravidelnom ticku.
 */
async function runAndRecord(db: Database, deps: PostaUncollectedRunDeps, now: Date, actorUserId: string): Promise<PostaUncollectedRunResult> {
  const [inserted] = await db
    .insert(jobRuns)
    .values({ jobName: POSTA_UNCOLLECTED_JOB_NAME, startedAt: now, status: "running" })
    .returning({ id: jobRuns.id });
  const runId = inserted?.id;
  try {
    // issue 193: "Spustiť teraz" je RUČNÁ akcia — kniha odoslaných e-mailov
    // to musí odlíšiť od nočného behu (`trigger`), aj s menom zamestnanca.
    const result = await runPostaUncollected({ db, now, ...deps, trigger: "manual", actorUserId });
    if (runId !== undefined) {
      await db.update(jobRuns).set({ status: "success", finishedAt: new Date(), detail: result }).where(eq(jobRuns.id, runId));
    }
    return result;
  } catch (error) {
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    log.error({ rawErrorMessage }, "Nevyzdvihnuté zásielky: ručný beh zlyhal");
    if (runId !== undefined) {
      await db.update(jobRuns).set({ status: "failure", finishedAt: new Date(), errorMessage: rawErrorMessage }).where(eq(jobRuns.id, runId));
    }
    throw error;
  }
}

export function registerPostaUncollectedRoutes(app: Hono<AppBindings>, db: Database, deps: PostaUncollectedRunDeps): void {
  // Čítanie — každý prihlásený zamestnanec (rovnaká úroveň ako "Sync zo
  // Shoptetu"/"Na objednanie", žiadny mutujúci vedľajší efekt).
  app.get("/api/posta-uncollected", requireUser(db), async (c) => {
    const [enabled, lastRun] = await Promise.all([isPostaUncollectedEnabled(db), getLatestJobRun(db, POSTA_UNCOLLECTED_JOB_NAME)]);
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

  // Štart/Stop — gate-uje LEN naplánovaný denný beh (`scheduler/jobs.ts`'s
  // `postaUncollectedJob`), nikdy "Spustiť teraz" nižšie (návrhový komentár
  // na issue 172).
  app.put(
    "/api/posta-uncollected/enabled",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", setEnabledBody),
    async (c) => {
      const { enabled } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();
      await setPostaUncollectedEnabled(db, enabled, now);
      await record(db, {
        at: now,
        actorUserId: user.userId,
        action: "posta_uncollected.enabled.set",
        entity: "posta_uncollected_settings",
        data: { enabled },
      });
      log.info({ actorUserId: user.userId, enabled }, "Nevyzdvihnuté zásielky: Štart/Stop");
      return c.json({ ok: true as const, enabled });
    },
  );

  // "Spustiť teraz" — VŽDY beží, bez ohľadu na `enabled` (explicitná ľudská
  // akcia, presne ako stará appka's `run_now`). Skutočné odoslanie e-mailu je
  // AJ TAK fail-closed na BCC/SMTP vnútri `runPostaUncollected` samotnej.
  app.post(
    "/api/posta-uncollected/run-now",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    async (c) => {
      const user = c.get("user");
      const now = new Date();
      let result: PostaUncollectedRunResult;
      try {
        result = await runAndRecord(db, deps, now, user.userId);
      } catch {
        return c.json({ error: "Beh zlyhal — skúste to znova o chvíľu." }, 502);
      }
      await record(db, {
        at: now,
        actorUserId: user.userId,
        action: "posta_uncollected.run_now",
        entity: "job_run",
        data: { stats: result.stats },
      });
      log.info({ actorUserId: user.userId, stats: result.stats }, "Nevyzdvihnuté zásielky: ručné spustenie");
      return c.json({ ok: true as const, result });
    },
  );

  // Náhľad — číta VÝHRADNE z POSLEDNÉHO uloženého behu (nikdy znova nehýta
  // posta.sk), presne ako stará appka's `/api/posta-uncollected/preview`.
  // Číslo e-mailu je NASLEDUJÚCI (už poslané + 1); po vyčerpaní kadencie
  // ukáže POSLEDNÝ odoslaný a označí `maxReached` — vymýšľať 5. e-mail, ktorý
  // sa nikdy nepošle, by bola lož.
  app.get(
    "/api/posta-uncollected/preview/:packageNumber",
    requireUser(db),
    zValidator("param", packageParam),
    async (c) => {
      const { packageNumber } = c.req.valid("param");
      const lastRun = await getLatestJobRun(db, POSTA_UNCOLLECTED_JOB_NAME);
      const result = lastRun !== null && isRunResult(lastRun.detail) ? lastRun.detail : null;
      const row = result?.uncollected.find((r) => r.packageNumber === packageNumber);
      if (row === undefined) {
        // 200 (nikdy 404) — rovnaká disciplína ako `/api/catalog/ingest`'s
        // "busy"/rejected a `sendSupplierOrderMail`'s "no_email"/"no_items":
        // toto je bežný, OČAKÁVANÝ doménový výsledok (zásielka medzičasom
        // vypadla z tabuľky), nikdy HTTP-úrovňová chyba — Chromium by inak
        // zalogoval "Failed to load resource" pri ktoromkoľvek e2e teste,
        // čo by porušilo jedinú povolenú konzolovú výnimku (`.claude/rules/
        // testing.md`).
        return c.json({ ok: false as const, error: "Zásielka sa v aktuálnom zozname nenašla." });
      }
      const already = row.count;
      const maxReached = already >= MAX_EMAILS;
      const count = Math.min(already + 1, MAX_EMAILS);
      const template = await resolveTemplate(db, postaTemplateKey(count));
      const built = buildEmail(template, row.name, packageNumber, row.officeName, row.officeAddr, row.retainedTill, new Date());
      return c.json({
        ok: true as const,
        subject: built.subject,
        html: built.html,
        recipient: row.email,
        name: row.name,
        packageNumber,
        orderCode: row.orderCode,
        count,
        alreadySent: already,
        maxReached,
      });
    },
  );
}
