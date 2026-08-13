import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { getLatestJobRun } from "../src/modules/scheduler/queries.js";
import { startRunNow, type RunNowOutcome } from "../src/modules/scheduler/run-now.js";
import { withCleanDb } from "./helpers/db.js";
import { waitForJobRunSettled } from "./helpers/job-run.js";

// issue 413: `startRunNow` je zdieľané jadro pre VŠETKÝCH šesť run-now
// automatizácií (shop-sitemap/pairing-search/posta-uncollected/
// order-reminder/supplier-stock/restock) — tieto testy overujú JEHO
// správanie priamo (nie cez HTTP), aby jedno pokrytie chránilo všetkých
// šesť volajúcich naraz. Vlastný, testovací lock kľúč (787_878_101) —
// mimo produkčného registra (`.claude/rules/scheduler.md`: 001-010 + 100
// obsadené), aby test nikdy nekolidoval so skutočným jobom.
const TEST_RUN_NOW_LOCK_KEY = 787_878_101;
const TEST_JOB_NAME = "run-now-test-job";

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function tryLockFromSeparateConnection(databaseUrl: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [TEST_RUN_NOW_LOCK_KEY]);
    const acquired = result.rows[0]?.locked === true;
    if (acquired) {
      await client.query("select pg_advisory_unlock($1)", [TEST_RUN_NOW_LOCK_KEY]);
    }
    return acquired;
  } finally {
    await client.end();
  }
}

let close: (() => Promise<void>) | undefined;
let checker: pg.Client | undefined;
afterEach(async () => {
  await checker?.end().catch(() => undefined);
  checker = undefined;
  await close?.();
  close = undefined;
});

describe("startRunNow — úspešný beh", () => {
  it("vloží 'running' riadok HNEĎ, vráti started BEZ čakania na dokončenie behu, a zapíše success PO dobehnutí", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    const work = deferred<{ readonly marker: string }>();
    const settled: RunNowOutcome<{ readonly marker: string }>[] = [];
    const now = new Date("2026-08-13T09:00:00Z");

    const outcome = await startRunNow(
      ctx.db,
      { jobName: TEST_JOB_NAME, lockKey: TEST_RUN_NOW_LOCK_KEY, run: () => work.promise },
      now,
      (o) => {
        settled.push(o);
      },
    );

    // HNEĎ po `startRunNow` (bez čakania na `work` dobehnutie) je odpoveď
    // "started" a job_run už existuje ako "running".
    expect(outcome).toEqual({ status: "started" });
    const runningRow = await getLatestJobRun(ctx.db, TEST_JOB_NAME);
    expect(runningRow?.status).toBe("running");
    expect(settled).toHaveLength(0);

    // Zámok je držaný počas celého behu — druhé pripojenie ho nedostane.
    expect(await tryLockFromSeparateConnection(process.env["DATABASE_URL"] ?? "")).toBe(false);

    work.resolve({ marker: "hotovo" });
    const finalRun = await waitForJobRunSettled(ctx.db, TEST_JOB_NAME);
    expect(finalRun.status).toBe("success");
    expect(finalRun.detail).toEqual({ marker: "hotovo" });
    expect(settled).toEqual([{ status: "success", result: { marker: "hotovo" } }]);

    // Zámok sa po dobehnutí uvoľnil.
    expect(await tryLockFromSeparateConnection(process.env["DATABASE_URL"] ?? "")).toBe(true);
  });
});

describe("startRunNow — zlyhaný beh", () => {
  it("zapíše failure s errorMessage a uvoľní zámok, aj keď beh vyhodí", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    const settled: RunNowOutcome<never>[] = [];
    const now = new Date("2026-08-13T09:10:00Z");

    const outcome = await startRunNow(
      ctx.db,
      {
        jobName: TEST_JOB_NAME,
        lockKey: TEST_RUN_NOW_LOCK_KEY,
        run: () => Promise.reject(new Error("simulované zlyhanie")),
      },
      now,
      (o) => {
        settled.push(o);
      },
    );
    expect(outcome).toEqual({ status: "started" });

    const finalRun = await waitForJobRunSettled(ctx.db, TEST_JOB_NAME);
    expect(finalRun.status).toBe("failure");
    expect(finalRun.errorMessage).toBe("simulované zlyhanie");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.status).toBe("failure");

    expect(await tryLockFromSeparateConnection(process.env["DATABASE_URL"] ?? "")).toBe(true);
  });
});

describe("startRunNow — zlyhanie PRI VKLADANÍ 'running' riadku (zámok už bol získaný)", () => {
  // Code review nález (issue 413): zámok sa berie PRED `db.insert(jobRuns)`.
  // Bez explicitného try/catch okolo insertu by JEHO zlyhanie (napr.
  // dočasný sieťový výpadok DB) nechalo zámok NAVŽDY držaný — `job.run()` sa
  // nikdy nespustí, takže fire-and-forget reťaz (a jej `.finally()`, čo by
  // inak zámok uvoľnilo) sa vôbec nezostaví. Rovnaký kľúč používa aj
  // NAPLÁNOVANÝ beh (`scheduler/jobs.ts`), takže by sa zablokoval tiež, až
  // do reštartu procesu.
  it("uvoľní zámok a vyhodí ĎALEJ — zámok NEOSTANE navždy držaný", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    // Atrapa, ktorá prepustí VŠETKO na skutočnú `db` (vrátane `$client`u
    // potrebného na získanie zámku) okrem `.insert`, ktoré synchrónne
    // vyhodí — rovnaký `Proxy`-vzor ako `shop-feed/run.test.ts`'s
    // `forbiddenDb`.
    const insertFailingDb = new Proxy(ctx.db, {
      get(target, prop, receiver: unknown) {
        if (prop === "insert") {
          return () => {
            throw new Error("simulované zlyhanie vloženia job_run riadku");
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return value;
      },
    });

    await expect(
      startRunNow(
        insertFailingDb,
        { jobName: TEST_JOB_NAME, lockKey: TEST_RUN_NOW_LOCK_KEY, run: () => Promise.resolve({ marker: "nikdy" }) },
        new Date(),
        () => {
          throw new Error("onSettled sa nikdy nemá zavolať, keď insert zlyhá PRED spustením run()");
        },
      ),
    ).rejects.toThrow("simulované zlyhanie vloženia job_run riadku");

    // Zámok sa uvoľnil aj napriek zlyhaniu insertu — druhé pripojenie ho
    // dostane HNEĎ, nikdy nezostane navždy zablokovaný.
    expect(await tryLockFromSeparateConnection(process.env["DATABASE_URL"] ?? "")).toBe(true);
    expect(await getLatestJobRun(ctx.db, TEST_JOB_NAME)).toBeNull();
  });
});

describe("startRunNow — busy (zámok už drží niekto iný)", () => {
  it("keď zámok drží MANUÁLNE vzatý zámok (žiadny job_run riadok), vráti busy so VŠEOBECNOU správou a NIKDY nezavolá run()", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    checker = new pg.Client({ connectionString: process.env["DATABASE_URL"] ?? "" });
    await checker.connect();
    await checker.query("select pg_advisory_lock($1)", [TEST_RUN_NOW_LOCK_KEY]);

    let runCalled = false;
    const outcome = await startRunNow(
      ctx.db,
      {
        jobName: TEST_JOB_NAME,
        lockKey: TEST_RUN_NOW_LOCK_KEY,
        run: () => {
          runCalled = true;
          return Promise.resolve({ marker: "nikdy" });
        },
      },
      new Date(),
      () => {
        throw new Error("onSettled sa pri busy nikdy nemá zavolať");
      },
    );

    expect(outcome.status).toBe("busy");
    if (outcome.status === "busy") {
      expect(outcome.message).toContain("Beh už prebieha");
      expect(outcome.message).not.toContain("spustený o");
    }
    expect(runCalled).toBe(false);
    expect(await getLatestJobRun(ctx.db, TEST_JOB_NAME)).toBeNull();
  });

  it("keď zámok drží PRÁVE PREBIEHAJÚCI run-now beh, druhý súbežný pokus dostane busy s ČASOM prvého behu a job_run ostáva NEDOTKNUTÝ", async () => {
    const ctx = await withCleanDb();
    close = ctx.close;
    const work = deferred<{ readonly marker: string }>();
    const now1 = new Date("2026-08-13T11:23:00Z");

    const outcome1 = await startRunNow(
      ctx.db,
      { jobName: TEST_JOB_NAME, lockKey: TEST_RUN_NOW_LOCK_KEY, run: () => work.promise },
      now1,
      () => undefined,
    );
    expect(outcome1).toEqual({ status: "started" });

    let secondRunCalled = false;
    const outcome2 = await startRunNow(
      ctx.db,
      {
        jobName: TEST_JOB_NAME,
        lockKey: TEST_RUN_NOW_LOCK_KEY,
        run: () => {
          secondRunCalled = true;
          return Promise.resolve({ marker: "nikdy" });
        },
      },
      new Date("2026-08-13T11:23:05Z"),
      () => {
        throw new Error("onSettled druhého (odmietnutého) behu sa nikdy nemá zavolať");
      },
    );

    expect(outcome2.status).toBe("busy");
    if (outcome2.status === "busy") {
      // 11:23 UTC = 13:23 Europe/Bratislava (letný čas) — presný formát
      // overuje `formatBratislavaTime` (`run-now.ts`), nie len prítomnosť
      // nejakého textu.
      expect(outcome2.message).toBe("Beh už prebieha (spustený o 13:23) — počkajte na jeho dokončenie.");
    }
    expect(secondRunCalled).toBe(false);

    // job_run riadok PRVÉHO behu ostal nedotknutý ("running", žiadny
    // druhý riadok nevznikol) — druhý pokus sa naň vôbec nepokúsil zapísať.
    const stillRunning = await getLatestJobRun(ctx.db, TEST_JOB_NAME);
    expect(stillRunning?.status).toBe("running");
    expect(stillRunning?.startedAt).toBe(now1.toISOString());

    work.resolve({ marker: "hotovo" });
    await waitForJobRunSettled(ctx.db, TEST_JOB_NAME);
  });
});
