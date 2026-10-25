// issue 598: Shoptet WAF od 21. 10. 2026 blokuje IP servera ~04:15–08:00+,
// a `restock` (Vypredané → Skladom, 04:50 a reťazený po supplier-stock) od
// 23. 10. každý deň padal na „locator.fill: Timeout … getByPlaceholder('E-mail')"
// a ticho nebežal. Teraz: zablokovaný beh naplánuje opakovanie (o 60 min, cez
// existujúci `startRunNow` + zámok restocku), a keď sa nepodarí ani posledný
// pokus pred obedom, vznikne karta na Upozorneniach — nikdy ticho nevynechané.
// Úspešný beh kartu zatvorí. Plánovanie sa odvodzuje z `job_run`, takže prežije
// aj reštart appky (`resume`).

import { and, eq, isNull } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { jobRuns, upozornenie } from "../src/db/schema.js";
import { RESTOCK_JOB_NAME } from "../src/modules/restock/constants.js";
import { setRestockEnabled } from "../src/modules/restock/run.js";
import { buildRestockAfterSupplierStock, restockJob, type RunRestock } from "../src/modules/scheduler/jobs.js";
import {
  RESTOCK_BLOCKED_DEDUP_KEY,
  RESTOCK_BLOCK_RETRY_INTERVAL_MS,
  RESTOCK_TRIGGER_BLOCK_RETRY,
  RestockBlockRetry,
  type RetryTimer,
} from "../src/modules/scheduler/restock-block-retry.js";
import { ShoptetBlockedError } from "../src/modules/shoptet-http/blocked.js";
import { withCleanDb } from "./helpers/db.js";
import { waitForJobRunSettled } from "./helpers/job-run.js";

// 26. 10. 2026 je už zimný čas (CET, UTC+1).
const AT_0450 = new Date("2026-10-26T03:50:00Z"); // 04:50 Europe/Bratislava
const AT_1030 = new Date("2026-10-26T09:30:00Z"); // 10:30
const AT_1130 = new Date("2026-10-26T10:30:00Z"); // 11:30
const AT_1000 = new Date("2026-10-26T09:00:00Z"); // 10:00

interface CapturedTimer {
  readonly callback: () => void;
  readonly delayMs: number;
  cancelled: boolean;
}

function fakeTimers(): { readonly timers: CapturedTimer[]; readonly setTimer: (callback: () => void, delayMs: number) => RetryTimer } {
  const timers: CapturedTimer[] = [];
  return {
    timers,
    setTimer: (callback, delayMs) => {
      const timer: CapturedTimer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
  };
}

const blockedRun: RunRestock = () => Promise.reject(new ShoptetBlockedError("prihlásenie do administrácie"));

async function openCards(db: Database): Promise<(typeof upozornenie.$inferSelect)[]> {
  return db.select().from(upozornenie).where(and(eq(upozornenie.dedupKey, RESTOCK_BLOCKED_DEDUP_KEY), isNull(upozornenie.resolvedAt)));
}

async function seedBlockedRun(db: Database, startedAt: Date): Promise<void> {
  await db.insert(jobRuns).values({
    jobName: RESTOCK_JOB_NAME,
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 30_000),
    status: "failure",
    errorMessage: new ShoptetBlockedError("prihlásenie do administrácie").message,
  });
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`Podmienka „${label}" sa nesplnila`);
}

let close: (() => Promise<void>) | undefined;
let retry: RestockBlockRetry | undefined;
afterEach(async () => {
  retry?.stop();
  retry = undefined;
  await close?.();
  close = undefined;
});

describe("restock pri bloku Shoptetu (issue 598)", () => {
  it("zablokovaný naplánovaný beh (04:50) → chyba shoptet_blocked (nie timeout lokátora) a opakovanie o 60 min", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    await setRestockEnabled(ctx.db, true, AT_0450);
    const { timers, setTimer } = fakeTimers();
    retry = new RestockBlockRetry({ db: ctx.db, run: blockedRun, setTimer, now: () => AT_0450 });

    const job = restockJob(blockedRun, retry.observe);
    await expect(job.run(ctx.db, AT_0450)).rejects.toThrow(/^shoptet_blocked:/);

    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(RESTOCK_BLOCK_RETRY_INTERVAL_MS);
    expect(RESTOCK_BLOCK_RETRY_INTERVAL_MS).toBe(60 * 60_000);
    expect(await openCards(ctx.db)).toEqual([]);
  });

  it("opakovanie beží cez startRunNow (vlastný job_run riadok restocku); znova zablokované → ďalšie opakovanie", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    await setRestockEnabled(ctx.db, true, AT_0450);
    await seedBlockedRun(ctx.db, AT_0450);
    const { timers, setTimer } = fakeTimers();
    retry = new RestockBlockRetry({ db: ctx.db, run: blockedRun, setTimer, now: () => AT_1000 });

    await retry.observe({ ok: false, error: new ShoptetBlockedError("prihlásenie do administrácie") });
    expect(timers).toHaveLength(1);
    timers[0]?.callback();

    await waitUntil(() => timers.length === 2, "druhé opakovanie naplánované");
    const runs = await ctx.db.select().from(jobRuns).where(eq(jobRuns.jobName, RESTOCK_JOB_NAME));
    expect(runs).toHaveLength(2);
    const latest = await waitForJobRunSettled(ctx.db, RESTOCK_JOB_NAME);
    expect(latest.status).toBe("failure");
    expect(latest.errorMessage).toMatch(/^shoptet_blocked:/);
  });

  it("opakovanie, ktoré uspeje, zapíše trigger do detailu a nič ďalšie neplánuje", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    await setRestockEnabled(ctx.db, true, AT_0450);
    await seedBlockedRun(ctx.db, AT_0450);
    const { timers, setTimer } = fakeTimers();
    const okRun: RunRestock = () => Promise.resolve({ status: "nothing_to_do", overLimit: 0 });
    retry = new RestockBlockRetry({ db: ctx.db, run: okRun, setTimer, now: () => AT_1000 });

    await retry.observe({ ok: false, error: new ShoptetBlockedError("prihlásenie do administrácie") });
    timers[0]?.callback();
    await waitUntil(() => !retry?.hasPendingRetry(), "opakovanie dobehlo");
    const latest = await waitForJobRunSettled(ctx.db, RESTOCK_JOB_NAME);
    expect(latest.status).toBe("success");
    expect(latest.detail).toEqual({ status: "nothing_to_do", overLimit: 0, trigger: RESTOCK_TRIGGER_BLOCK_RETRY });
    expect(timers).toHaveLength(1);
  });

  it("posledný pokus pred obedom zablokovaný → karta na Upozorneniach, žiadne ďalšie opakovanie", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    await seedBlockedRun(ctx.db, AT_0450);
    await seedBlockedRun(ctx.db, AT_1030);
    const { timers, setTimer } = fakeTimers();
    retry = new RestockBlockRetry({ db: ctx.db, run: blockedRun, setTimer, now: () => AT_1130 });

    await retry.observe({ ok: false, error: new ShoptetBlockedError("prihlásenie do administrácie") });

    expect(timers).toEqual([]);
    const cards = await openCards(ctx.db);
    expect(cards).toHaveLength(1);
    const [card] = cards;
    expect(card?.type).toBe("shoptet_blokovanie");
    expect(card?.source).toBe("appka");
    expect(card?.title).toContain("Vypredané → Skladom");
    expect(card?.details).toContain("Access temporarily blocked");
    expect(card?.details).toContain("2");
    expect(card?.link).toBe("/?tab=restock");
  });

  it("opakované vyčerpanie v ďalší deň karty nezdvojí (jedna otvorená karta, obnovená)", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    const { setTimer } = fakeTimers();
    retry = new RestockBlockRetry({ db: ctx.db, run: blockedRun, setTimer, now: () => AT_1130 });
    await retry.observe({ ok: false, error: new ShoptetBlockedError("x") });
    await retry.observe({ ok: false, error: new ShoptetBlockedError("x") });
    expect(await openCards(ctx.db)).toHaveLength(1);
  });

  it("úspešný beh restocku po bloku kartu automaticky zatvorí", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    const { setTimer } = fakeTimers();
    retry = new RestockBlockRetry({ db: ctx.db, run: blockedRun, setTimer, now: () => AT_1130 });
    await retry.observe({ ok: false, error: new ShoptetBlockedError("x") });
    expect(await openCards(ctx.db)).toHaveLength(1);

    await retry.observe({ ok: true });
    expect(await openCards(ctx.db)).toEqual([]);
  });

  it("iná chyba než blok (napr. zlé heslo) nič neplánuje a kartu nezakladá", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    const { timers, setTimer } = fakeTimers();
    retry = new RestockBlockRetry({ db: ctx.db, run: blockedRun, setTimer, now: () => AT_0450 });
    await retry.observe({ ok: false, error: new Error("Prihlásenie do Shoptetu zlyhalo (prihlasovací formulár stále viditeľný)") });
    expect(timers).toEqual([]);
    expect(await openCards(ctx.db)).toEqual([]);
  });

  it("dva zablokované behy za sebou (04:50 + reťazený) naplánujú len JEDNO opakovanie", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    const { timers, setTimer } = fakeTimers();
    retry = new RestockBlockRetry({ db: ctx.db, run: blockedRun, setTimer, now: () => AT_0450 });
    await retry.observe({ ok: false, error: new ShoptetBlockedError("x") });
    await retry.observe({ ok: false, error: new ShoptetBlockedError("x") });
    expect(timers).toHaveLength(1);
  });

  it("opakovanie, keď medzitým iný restock beh uspel, nič nespustí", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    await setRestockEnabled(ctx.db, true, AT_0450);
    const { timers, setTimer } = fakeTimers();
    let runCalls = 0;
    const countingRun: RunRestock = () => {
      runCalls += 1;
      return Promise.resolve({ status: "nothing_to_do", overLimit: 0 });
    };
    retry = new RestockBlockRetry({ db: ctx.db, run: countingRun, setTimer, now: () => AT_1000 });
    await retry.observe({ ok: false, error: new ShoptetBlockedError("x") });
    await ctx.db.insert(jobRuns).values({ jobName: RESTOCK_JOB_NAME, startedAt: AT_1000, finishedAt: AT_1000, status: "success", detail: { status: "nothing_to_do", overLimit: 0 } });

    timers[0]?.callback();
    await waitUntil(() => !retry?.hasPendingRetry(), "opakovanie vyhodnotené");
    expect(runCalls).toBe(0);
    expect(await ctx.db.select().from(jobRuns).where(eq(jobRuns.jobName, RESTOCK_JOB_NAME))).toHaveLength(1);
  });

  it("resume po reštarte appky: dnešný posledný beh zablokovaný → opakovanie sa naplánuje na zvyšný čas", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    await seedBlockedRun(ctx.db, AT_1000); // dobehol 10:00:30
    const { timers, setTimer } = fakeTimers();
    const now = new Date(AT_1000.getTime() + 20 * 60_000); // 10:20
    retry = new RestockBlockRetry({ db: ctx.db, run: blockedRun, setTimer, now: () => now });

    await retry.resume();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(40 * 60_000 + 30_000);
  });

  it("resume: včerajší zablokovaný beh ani dnešný úspech nič neplánuje", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    await seedBlockedRun(ctx.db, new Date(AT_1000.getTime() - 24 * 60 * 60_000));
    const { timers, setTimer } = fakeTimers();
    retry = new RestockBlockRetry({ db: ctx.db, run: blockedRun, setTimer, now: () => AT_1000 });
    await retry.resume();
    expect(timers).toEqual([]);
  });

  it("reťazený restock za supplier-stock pri bloku tiež naplánuje opakovanie", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    await setRestockEnabled(ctx.db, true, AT_0450);
    const { timers, setTimer } = fakeTimers();
    retry = new RestockBlockRetry({ db: ctx.db, run: blockedRun, setTimer, now: () => AT_0450 });

    const afterRun = buildRestockAfterSupplierStock(blockedRun, retry.observe);
    await afterRun(ctx.db, AT_0450);
    const settled = await waitForJobRunSettled(ctx.db, RESTOCK_JOB_NAME);
    expect(settled.status).toBe("failure");
    expect(settled.errorMessage).toMatch(/^shoptet_blocked:/);
    await waitUntil(() => timers.length === 1, "opakovanie po reťazenom behu");
  });
});
