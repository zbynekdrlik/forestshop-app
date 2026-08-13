import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import { MAX_EMAILS } from "../modules/posta-uncollected/constants.js";
import { resolveTemplate } from "../modules/mail-templates/store.js";
import { buildEmail, postaTemplateKey } from "../modules/posta-uncollected/logic.js";
import { POSTA_UNCOLLECTED_JOB_NAME } from "../modules/scheduler/jobs.js";
import { getLatestJobRun } from "../modules/scheduler/queries.js";
import { startRunNow, type RunNowStart } from "../modules/scheduler/run-now.js";
import type { PostaUncollectedRunResult, RunPostaUncollectedOptions } from "../modules/posta-uncollected/run.js";
import { POSTA_UNCOLLECTED_RUN_LOCK_KEY, runPostaUncollectedLocked } from "../modules/posta-uncollected/run.js";
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

// issue 413: `startRunNow` (zdieľané naprieč všetkými 6 run-now
// automatizáciami) — vloží "running" riadok HNEĎ a vráti odpoveď BEZ
// čakania na celý beh (predtým synchrónne, viď design komentár na tikete —
// Cloudflare tunel 100s timeout spôsoboval 524 + duplicitný beh). Audit
// (`record()`) sa zapisuje AŽ keď beh na pozadí dobehne úspešne — presne
// TÁ ISTÁ podmienka, akú mal pôvodný synchrónny kód (žiadny audit riadok
// pri zlyhaní, len `job_run.status = "failure"`).

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
      let outcome: RunNowStart;
      try {
        outcome = await startRunNow(
          db,
          {
            jobName: POSTA_UNCOLLECTED_JOB_NAME,
            lockKey: POSTA_UNCOLLECTED_RUN_LOCK_KEY,
            // issue 193: "Spustiť teraz" je RUČNÁ akcia — kniha odoslaných
            // e-mailov to musí odlíšiť od nočného behu (`trigger`), aj s
            // menom zamestnanca.
            run: (runNow) => runPostaUncollectedLocked({ db, now: runNow, ...deps, trigger: "manual", actorUserId: user.userId }),
          },
          now,
          async (settled) => {
            // Audit sa zapisuje LEN pri úspechu — presne ako pôvodný
            // synchrónny kód (žiadny audit riadok pri zlyhaní, len
            // `job_run.status = "failure"`, ktoré `startRunNow` už zapísalo).
            if (settled.status !== "success") return;
            await record(db, {
              at: now,
              actorUserId: user.userId,
              action: "posta_uncollected.run_now",
              entity: "job_run",
              data: { stats: settled.result.stats },
            });
            log.info({ actorUserId: user.userId, stats: settled.result.stats }, "Nevyzdvihnuté zásielky: ručné spustenie");
          },
        );
      } catch {
        return c.json({ error: "Beh sa nepodarilo spustiť — skúste to znova o chvíľu." }, 500);
      }
      // issue 413: "busy" je BEŽNÝ, OČAKÁVANÝ doménový výsledok (druhý klik/
      // Cloudflare retry počas prebiehajúceho behu) — 200, nikdy 4xx/5xx
      // (`.claude/rules/testing.md`'s "Chromium loguje KAŽDÚ 4xx/5xx do
      // konzoly" disciplína).
      if (outcome.status === "busy") return c.json({ error: outcome.message }, 200);
      return c.json({ ok: true as const, started: true as const }, 202);
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
