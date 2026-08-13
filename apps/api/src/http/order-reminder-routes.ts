import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { jobRuns } from "../db/schema.js";
import { log } from "../logger.js";
import { record } from "../modules/audit/service.js";
import { resolveTemplate } from "../modules/mail-templates/store.js";
import { buildReminderEmail } from "../modules/order-reminder/logic.js";
import { ORDER_REMINDER_JOB_NAME } from "../modules/scheduler/jobs.js";
import { getLatestJobRun } from "../modules/scheduler/queries.js";
import { startRunNow, type RunNowStart } from "../modules/scheduler/run-now.js";
import { ORDER_REMINDER_RUN_LOCK_KEY } from "../modules/order-reminder/constants.js";
import type { OrderReminderRow, OrderReminderRunResult, RunOrderReminderOptions } from "../modules/order-reminder/run.js";
import { runOrderReminderLocked, runOrderReminderOverride } from "../modules/order-reminder/run.js";
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

// issue 413: manuálne "Spustiť teraz" ide cez zdieľaný `startRunNow`
// (`modules/scheduler/run-now.ts`) — vloží "running" riadok HNEĎ a vráti
// odpoveď BEZ čakania na celý beh (predtým synchrónne; Cloudflare tunel
// 100s timeout spôsoboval 524 + duplicitný beh). `GET /api/order-reminder`
// tak vidí manuálny beh HNEĎ AKO ZAČAL (status "running"), nielen po
// dobehnutí.

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

/**
 * Ručná akcia (override) mení LEN `order_reminder_state` — na rozdiel od
 * "Spustiť teraz" nezapíše nový `job_run` riadok. Bez tohto by `GET
 * /api/order-reminder` po úspešnej ručnej akcii ukázal STARÝ, nezmenený
 * posledný beh (riadok by zostal v pôvodnej tabuľke, kým nepríde ĎALŠÍ
 * naplánovaný/manuálny beh) — manažér by videl akciu "zaúčinkovať" v
 * databáze, ale nie na obrazovke. Presúva riadok do správnej skupiny
 * PRIAMO v poslednom uloženom `job_run.detail`, rovnaký zámer ako stará
 * appka's `_relocate` (`webreview/app.py`).
 */
async function relocateAfterOverride(
  db: Database,
  orderCode: string,
  resolution: "contacted" | "emailed",
): Promise<void> {
  const [latest] = await db
    .select({ id: jobRuns.id, detail: jobRuns.detail })
    .from(jobRuns)
    .where(eq(jobRuns.jobName, ORDER_REMINDER_JOB_NAME))
    .orderBy(desc(jobRuns.startedAt))
    .limit(1);
  if (latest === undefined || !isRunResult(latest.detail)) return;
  const result = latest.detail;
  const row = findRow(result, orderCode);
  if (row === undefined) return;

  const resolvedRow = {
    orderCode: row.orderCode,
    adminLink: row.adminLink,
    name: row.name,
    phone: row.phone,
    email: row.email,
    itemLabel: row.itemLabel,
    days: row.days,
    resolvedAt: new Date().toISOString(),
    resolvedBy: "manual" as const,
  };
  const stripped: OrderReminderRunResult = {
    ...result,
    noNote: result.noNote.filter((r) => r.orderCode !== orderCode),
    noEmail: result.noEmail.filter((r) => r.orderCode !== orderCode),
    pending: result.pending.filter((r) => r.orderCode !== orderCode),
    contacted: result.contacted.filter((r) => r.orderCode !== orderCode),
    emailed: result.emailed.filter((r) => r.orderCode !== orderCode),
  };
  const updated: OrderReminderRunResult =
    resolution === "emailed" ? { ...stripped, emailed: [...stripped.emailed, resolvedRow] } : { ...stripped, contacted: [...stripped.contacted, resolvedRow] };
  await db.update(jobRuns).set({ detail: updated }).where(eq(jobRuns.id, latest.id));
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
      let outcome: RunNowStart;
      try {
        outcome = await startRunNow(
          db,
          {
            jobName: ORDER_REMINDER_JOB_NAME,
            lockKey: ORDER_REMINDER_RUN_LOCK_KEY,
            // issue 193: "Spustiť teraz" je RUČNÁ akcia (kniha odoslaných e-mailov).
            run: (runNow) => runOrderReminderLocked({ db, now: runNow, ...deps, trigger: "manual", actorUserId: user.userId }),
          },
          now,
          async (settled) => {
            if (settled.status !== "success") return;
            await record(db, {
              at: now,
              actorUserId: user.userId,
              action: "order_reminder.run_now",
              entity: "job_run",
              data: { stats: settled.result.stats },
            });
            log.info({ actorUserId: user.userId, stats: settled.result.stats }, "Pripomienky objednávok: ručné spustenie");
          },
        );
      } catch {
        return c.json({ error: "Beh sa nepodarilo spustiť — skúste to znova o chvíľu." }, 500);
      }
      // issue 413: "busy" je bežný, očakávaný doménový výsledok — 200, nikdy
      // 4xx/5xx (`.claude/rules/testing.md`).
      if (outcome.status === "busy") return c.json({ error: outcome.message }, 200);
      return c.json({ ok: true as const, started: true as const }, 202);
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
      // issue 193: ručná per-riadková akcia sa v knihe odoslaných e-mailov
      // pripíše zamestnancovi, ktorý ju stlačil.
      const result = await runOrderReminderOverride({ db, now, orderCode, action, ...deps, trigger: "manual", actorUserId: user.userId });
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
      await relocateAfterOverride(db, orderCode, result.resolution);
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
      const built = buildReminderEmail(await resolveTemplate(db, "order_reminder"), row.name, orderCode);
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
