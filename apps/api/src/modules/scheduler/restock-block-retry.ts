// issue 598: „Vypredané → Skladom" (restock) pri bloku Shoptetu.
//
// Od 21. 10. 2026 Shoptet WAF každé ráno (~04:15 – 08:00, niekedy dlhšie)
// blokuje IP servera FClaude, a restock beží o 04:50 aj reťazený po
// supplier-stocku (~06:15) — teda presne v okne bloku. Od 23. 10. preto každý
// deň padal a ticho nebežal. Tento modul:
//
// 1. po zablokovanom behu naplánuje OPAKOVANIE o `RESTOCK_BLOCK_RETRY_INTERVAL_MS`
//    cez EXISTUJÚCI `startRunNow` (neblokujúci `pg_try_advisory_lock` na
//    `RESTOCK_RUN_LOCK_KEY`, vlastný `job_run` riadok s `trigger`), najviac do
//    `RESTOCK_BLOCK_RETRY_CUTOFF_HOUR_LOCAL` miestneho času;
// 2. keď ani posledný pokus pred touto hranicou neprejde, založí kartu na
//    Upozorneniach (`upsertUpozornenie`, JEDINÁ zapisovacia cesta) — nikdy ticho
//    nevynechané;
// 3. úspešný beh restocku kartu automaticky zatvorí (znova-ohlásiteľná
//    kategória, `.claude/rules/upozornenia.md`).
//
// Rozhodnutie sa vždy odvodzuje z PERZISTOVANÉHO `job_run` (rovnaký princíp ako
// samotný plánovač): časovač v pamäti je len budík. Pri spustení si overí, že
// posledný restock beh je STÁLE zablokovaný (inak — niekto medzitým uspel —
// nič nerobí), a po reštarte appky `resume()` budík obnoví z `job_run`.

import { and, desc, eq, gte } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { jobRuns } from "../../db/schema.js";
import { log } from "../../logger.js";
import { getZonedDateParts, zonedDateKey } from "../../timezone.js";
import { RESTOCK_JOB_NAME, RESTOCK_RUN_LOCK_KEY } from "../restock/constants.js";
import type { RestockRunResult } from "../restock/run.js";
import { isShoptetBlockedError, isShoptetBlockedMessage } from "../shoptet-http/blocked.js";
import { autoResolveByDedupKey, upsertUpozornenie } from "../upozornenia/service.js";
import { decideRestockRun, runObservedRestock, type RunRestock } from "./jobs.js";
import { getLatestJobRun } from "./queries.js";
import { startRunNow } from "./run-now.js";

export const RESTOCK_BLOCK_RETRY_INTERVAL_MS = 60 * 60_000;
/** Posledný pokus musí ŠTARTOVAŤ pred touto miestnou hodinou (Europe/Bratislava). */
export const RESTOCK_BLOCK_RETRY_CUTOFF_HOUR_LOCAL = 12;
export const RESTOCK_TRIGGER_BLOCK_RETRY = "retry-after-shoptet-block";
export const RESTOCK_BLOCKED_DEDUP_KEY = "restock:shoptet-blokovane";
const RESTOCK_TAB_LINK = "/?tab=restock";

export type RestockRunOutcome = { readonly ok: true } | { readonly ok: false; readonly error: unknown };
/** Hák, ktorý dostane výsledok KAŽDÉHO restock behu (naplánovaný 04:50, reťazený, opakovanie). Nikdy nevyhodí. */
export type RestockRunObserver = (outcome: RestockRunOutcome) => Promise<void>;

export interface RetryTimer {
  cancel(): void;
}

export interface RestockBlockRetryOptions {
  readonly db: Database;
  /** ODOMKNUTÝ variant (`runRestockLocked`) — `startRunNow` zámok restocku už drží. `undefined` = chýbajú Shoptet údaje. */
  readonly run: RunRestock | undefined;
  readonly intervalMs?: number;
  readonly cutoffHourLocal?: number;
  /** Testy vstrekujú vlastný budík (nikdy skutočné čakanie hodinu). */
  readonly setTimer?: (callback: () => void, delayMs: number) => RetryTimer;
  readonly now?: () => Date;
}

const defaultSetTimer = (callback: () => void, delayMs: number): RetryTimer => {
  const handle = setTimeout(callback, delayMs);
  handle.unref();
  return {
    cancel: () => {
      clearTimeout(handle);
    },
  };
};

function formatLocalTime(instant: Date): string {
  const { hour, minute } = getZonedDateParts(instant);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export class RestockBlockRetry {
  private readonly db: Database;
  private readonly run: RunRestock | undefined;
  private readonly intervalMs: number;
  private readonly cutoffHourLocal: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => RetryTimer;
  private readonly now: () => Date;
  private pending: RetryTimer | null = null;
  private firing = false;

  constructor(options: RestockBlockRetryOptions) {
    this.db = options.db;
    this.run = options.run;
    this.intervalMs = options.intervalMs ?? RESTOCK_BLOCK_RETRY_INTERVAL_MS;
    this.cutoffHourLocal = options.cutoffHourLocal ?? RESTOCK_BLOCK_RETRY_CUTOFF_HOUR_LOCAL;
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.now = options.now ?? (() => new Date());
  }

  /** `true`, kým je naplánované (alebo práve beží) opakovanie. */
  hasPendingRetry(): boolean {
    return this.pending !== null || this.firing;
  }

  stop(): void {
    this.pending?.cancel();
    this.pending = null;
  }

  readonly observe: RestockRunObserver = async (outcome) => {
    try {
      if (outcome.ok) {
        const closed = await autoResolveByDedupKey(this.db, RESTOCK_BLOCKED_DEDUP_KEY, this.now());
        if (closed) log.info("restock: beh prešiel — karta o bloku Shoptetu automaticky zatvorená");
        return;
      }
      if (!isShoptetBlockedError(outcome.error)) return;
      await this.handleBlocked(this.now(), this.intervalMs);
    } catch (error) {
      // Hák nikdy nesmie zhodiť samotný beh restocku ani plánovač.
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      log.error({ rawErrorMessage }, "restock: spracovanie bloku Shoptetu zlyhalo");
    }
  };

  /** Po štarte appky: dnešný posledný restock beh zablokovaný → obnov budík (alebo kartu, ak už je po hranici). */
  async resume(): Promise<void> {
    const latest = await getLatestJobRun(this.db, RESTOCK_JOB_NAME);
    if (latest === null || latest.status !== "failure" || !isShoptetBlockedMessage(latest.errorMessage)) return;
    const failedAt = new Date(latest.finishedAt ?? latest.startedAt);
    const now = this.now();
    if (zonedDateKey(failedAt) !== zonedDateKey(now)) return;
    const remainingMs = Math.max(0, failedAt.getTime() + this.intervalMs - now.getTime());
    log.info({ failedAt: failedAt.toISOString(), remainingMs }, "restock: po štarte appky obnovujem opakovanie po bloku Shoptetu");
    await this.handleBlocked(now, remainingMs);
  }

  private async handleBlocked(now: Date, delayMs: number): Promise<void> {
    const nextAttempt = new Date(now.getTime() + delayMs);
    const withinWindow = zonedDateKey(nextAttempt) === zonedDateKey(now) && getZonedDateParts(nextAttempt).hour < this.cutoffHourLocal;
    if (!withinWindow) {
      await this.raiseCard(now);
      return;
    }
    if (this.pending !== null) {
      log.info("restock: zablokovaný beh — opakovanie je už naplánované, ďalšie nepridávam");
      return;
    }
    log.warn({ nextAttemptLocal: formatLocalTime(nextAttempt), delayMs }, "restock: Shoptet blokuje IP — naplánované opakovanie");
    this.pending = this.setTimer(() => {
      this.pending = null;
      this.firing = true;
      void this.fire().finally(() => {
        this.firing = false;
      });
    }, delayMs);
  }

  private async fire(): Promise<void> {
    try {
      const latest = await getLatestJobRun(this.db, RESTOCK_JOB_NAME);
      if (latest !== null && !(latest.status === "failure" && isShoptetBlockedMessage(latest.errorMessage))) {
        log.info({ latestStatus: latest.status }, "restock: opakovanie po bloku netreba — posledný beh nie je zablokovaný");
        return;
      }
      const start = await startRunNow(
        this.db,
        { jobName: RESTOCK_JOB_NAME, lockKey: RESTOCK_RUN_LOCK_KEY, run: (n) => this.runRetry(n) },
        this.now(),
        // Výsledok pozoruje `runRetry` (cez `runObservedRestock`), nie tento hák —
        // vypnutý restock (`skip`) nesmie zatvoriť kartu ako „prešlo".
        () => undefined,
      );
      // „busy" = iný restock práve beží; jeho vlastný výsledok prejde cez `observe`.
      log.info({ start: start.status }, "restock: opakovanie po bloku Shoptetu spustené");
    } catch (error) {
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      log.error({ rawErrorMessage }, "restock: spustenie opakovania po bloku zlyhalo");
    }
  }

  private async runRetry(now: Date): Promise<Record<string, unknown>> {
    const decision = await decideRestockRun(this.db, this.run);
    if (decision.action === "skip") return { ...decision.detail, trigger: RESTOCK_TRIGGER_BLOCK_RETRY };
    const result: RestockRunResult = await runObservedRestock(this.db, now, decision.run, this.observe);
    return { ...result, trigger: RESTOCK_TRIGGER_BLOCK_RETRY };
  }

  private async raiseCard(now: Date): Promise<void> {
    const blockedToday = await this.countBlockedRunsToday(now);
    const details = [
      "Shoptet dočasne zablokoval IP adresu servera FClaude (stránka „Access temporarily blocked“ — podozrivá aktivita, ktorá vyzerala ako útok).",
      `Prepnutie vypredaných produktov späť na „Skladom" sa dnes skúšalo ${String(blockedToday)}-krát, naposledy o ${formatLocalTime(now)}, a ani raz sa nedalo prihlásiť do administrácie.`,
      "Ďalší pokus príde s najbližším naplánovaným behom (zajtra ráno). Ak blokovanie pretrváva, treba kontaktovať podporu Shoptetu (info@shoptet.cz).",
    ].join("\n");
    await upsertUpozornenie(this.db, {
      type: "shoptet_blokovanie",
      source: "appka",
      title: "Vypredané → Skladom dnes nebežalo — Shoptet blokuje server",
      details,
      link: RESTOCK_TAB_LINK,
      dedupKey: RESTOCK_BLOCKED_DEDUP_KEY,
      now,
    });
    log.error({ blockedToday }, "restock: ani posledný pokus pred obedom neprešiel (blok Shoptetu) — karta na Upozorneniach");
  }

  private async countBlockedRunsToday(now: Date): Promise<number> {
    const rows = await this.db
      .select({ startedAt: jobRuns.startedAt, status: jobRuns.status, errorMessage: jobRuns.errorMessage })
      .from(jobRuns)
      .where(and(eq(jobRuns.jobName, RESTOCK_JOB_NAME), gte(jobRuns.startedAt, new Date(now.getTime() - 24 * 60 * 60_000))))
      .orderBy(desc(jobRuns.startedAt));
    const today = zonedDateKey(now);
    const count = rows.filter((r) => r.status === "failure" && isShoptetBlockedMessage(r.errorMessage) && zonedDateKey(r.startedAt) === today).length;
    // Volané aj z behu, ktorého `job_run` riadok ešte nie je zapísaný ako failure.
    return Math.max(count, 1);
  }
}
