import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { jobRuns } from "../db/schema.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import { buildReminderEmail } from "../modules/order-reminder/logic.js";
import { ORDER_REMINDER_JOB_NAME } from "../modules/scheduler/jobs.js";
import { getLatestJobRun } from "../modules/scheduler/queries.js";
import type { OrderReminderRow, OrderReminderRunResult, RunOrderReminderOptions } from "../modules/order-reminder/run.js";
import { runOrderReminder, runOrderReminderOverride } from "../modules/order-reminder/run.js";
import { isOrderReminderEnabled, setOrderReminderEnabled } from "../modules/order-reminder/settings.js";
import { requireRole, requireUser, type AppBindings } from "./middleware.js";
import { requireSameOrigin } from "./origin-check.js";

const setEnabledBody = z.object({ enabled: z.boolean() });
const orderCodeParam = z.object({ orderCode: z.string().min(1) });
const overrideBody = z.object({ orderCode: z.string().min(1), action: z.enum(["contact", "send"]) });

// `Omit<..., "db" | "now">` — HTTP vrstva len dodá `db`/`now`, business
// dependencies (AI klasifikátor, mail transport, BCC adresa, admin base url)
// zostavuje `index.ts` presne raz pri štarte procesu (rovnaký vzor ako
// #172's `PostaUncollectedRunDeps`).
export type OrderReminderRunDeps = Omit<RunOrderReminderOptions, "db" | "now">;

function isRunResult(detail: unknown): detail is OrderReminderRunResult {
  return typeof detail === "object" && detail !== null && "noNote" in detail;
}

/**
 * Manuálne "Spustiť teraz" aj naplánovaný beh zapisujú job_run TÝM ISTÝM
 * vzorom, aký #172's `runAndRecord` používa — `GET /api/order-reminder` tak
 * vidí manuálny beh HNEĎ, nielen po ďalšom pravidelnom ticku.
 */
async function runAndRecord(db: Database, deps: OrderReminderRunDeps, now: Date): Promise<OrderReminderRunResult> {
  const [inserted] = await db
    .insert(jobRuns)
    .values({ jobName: ORDER_REMINDER_JOB_NAME, startedAt: now, status: "running" })
    .returning({ id: jobRuns.id });
  const runId = inserted?.id;
  try {
    const result = await runOrderReminder({ db, now, ...deps });
    if (runId !== undefined) {
      await db.update(jobRuns).set({ status: "success", finishedAt: new Date(), detail: result }).where(eq(jobRuns.id, runId));
    }
    return result;
  } catch (error) {
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    log.error({ rawErrorMessage }, "Pripomienky objednávok: ručný beh zlyhal");
    if (runId !== undefined) {
      await db.update(jobRuns).set({ status: "failure", finishedAt: new Date(), errorMessage: rawErrorMessage }).where(eq(jobRuns.id, runId));
    }
    throw error;
  }
}

function findRow(result: OrderReminderRunResult | null, orderCode: string): OrderReminderRow | undefined {
  if (result === null) return undefined;
  return (
    result.noNote.find((r) => r.orderCode === orderCode) ??
    result.noEmail.find((r) => r.orderCode === orderCode) ??
    result.emailed.find((r) => r.orderCode === orderCode) ??
    result.contacted.find((r) => r.orderCode === orderCode) ??
    result.pending.find((r) => r.orderCode === orderCode)
  );
}

export function registerOrderReminderRoutes(app: Hono<AppBindings>, db: Database, deps: OrderReminderRunDeps): void {
  // Čítanie — každý prihlásený zamestnanec (rovnaká úroveň ako #172).
  app.get("/api/order-reminder", requireUser(db), async (c) => {
    const [enabled, lastRun] = await Promise.all([isOrderReminderEnabled(db), getLatestJobRun(db, ORDER_REMINDER_JOB_NAME)]);
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
  // `orderReminderJob`), nikdy "Spustiť teraz"/ručné akcie nižšie.
  app.put(
    "/api/order-reminder/enabled",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", setEnabledBody),
    async (c) => {
      const { enabled } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();
      await setOrderReminderEnabled(db, enabled, now);
      await record(db, {
        at: now,
        actorUserId: user.userId,
        action: "order_reminder.enabled.set",
        entity: "order_reminder_settings",
        data: { enabled },
      });
      log.info({ actorUserId: user.userId, enabled }, "Pripomienky objednávok: Štart/Stop");
      return c.json({ ok: true as const, enabled });
    },
  );

  // "Spustiť teraz" — VŽDY beží, bez ohľadu na `enabled`.
  app.post(
    "/api/order-reminder/run-now",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    async (c) => {
      const user = c.get("user");
      const now = new Date();
      let result: OrderReminderRunResult;
      try {
        result = await runAndRecord(db, deps, now);
      } catch {
        return c.json({ error: "Beh zlyhal — skúste to znova o chvíľu." }, 502);
      }
      await record(db, {
        at: now,
        actorUserId: user.userId,
        action: "order_reminder.run_now",
        entity: "job_run",
        data: { stats: result.stats },
      });
      log.info({ actorUserId: user.userId, stats: result.stats }, "Pripomienky objednávok: ručné spustenie");
      return c.json({ ok: true as const, result });
    },
  );

  // Ručný per-riadkový override ("▶ Poslať pripomienku"/"✓ Kontaktované") —
  // dovolené na akomkoľvek nevyriešenom/AI-nesprávnom riadku, nikdy na už
  // odoslanom (žiadny druhý mail).
  app.post(
    "/api/order-reminder/override",
    requireSameOrigin(),
    requireUser(db),
    requireRole("admin", "manazer"),
    zValidator("json", overrideBody),
    async (c) => {
      const { orderCode, action } = c.req.valid("json");
      const user = c.get("user");
      const now = new Date();
      const result = await runOrderReminderOverride({ db, now, orderCode, action, ...deps });
      if (!result.ok) {
        const message =
          result.code === "not_found"
            ? "Objednávka sa v aktuálnom zozname nenašla."
            : result.code === "already_resolved"
              ? result.resolution === "emailed"
                ? "Pripomienka už bola odoslaná."
                : "Objednávka je už označená ako kontaktovaná."
              : result.code === "no_email"
                ? "Objednávka nemá e-mailovú adresu."
                : result.code === "not_configured"
                  ? result.reason
                  : "Odoslanie e-mailu zlyhalo — skúste to znova.";
        return c.json({ ok: false as const, error: message });
      }
      await record(db, {
        at: now,
        actorUserId: user.userId,
        action: "order_reminder.override",
        entity: "order_reminder_state",
        entityId: orderCode,
        data: { action, resolution: result.resolution },
      });
      log.info({ actorUserId: user.userId, orderCode, action }, "Pripomienky objednávok: ručná akcia");
      return c.json({ ok: true as const, resolution: result.resolution });
    },
  );

  // Náhľad — číta VÝHRADNE z POSLEDNÉHO uloženého behu (nikdy znova
  // neklasifikuje/neposiela), presne ako #172's preview.
  app.get(
    "/api/order-reminder/preview/:orderCode",
    requireUser(db),
    zValidator("param", orderCodeParam),
    async (c) => {
      const { orderCode } = c.req.valid("param");
      const lastRun = await getLatestJobRun(db, ORDER_REMINDER_JOB_NAME);
      const result = lastRun !== null && isRunResult(lastRun.detail) ? lastRun.detail : null;
      const row = findRow(result, orderCode);
      if (row === undefined) {
        // 200 (nikdy 404) — rovnaká disciplína ako #172's preview
        // (`.claude/rules/testing.md`'s Chromium console-error pravidlo).
        return c.json({ ok: false as const, error: "Objednávka sa v aktuálnom zozname nenašla." });
      }
      const built = buildReminderEmail(row.name, orderCode);
      return c.json({
        ok: true as const,
        subject: built.subject,
        html: built.html,
        recipient: row.email,
        name: row.name,
        orderCode,
      });
    },
  );
}
