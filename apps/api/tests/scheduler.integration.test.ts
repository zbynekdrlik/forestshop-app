import pg from "pg";
import { afterEach, expect, it } from "vitest";
import { jobRuns } from "../src/db/schema.js";
import { SCHEDULER_ADVISORY_LOCK_KEY, tick } from "../src/modules/scheduler/scheduler.js";
import { listLatestJobRuns } from "../src/modules/scheduler/queries.js";
import type { ScheduledJob } from "../src/modules/scheduler/types.js";
import { withCleanDb } from "./helpers/db.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

// issue 293: `hourLocal`/`minuteLocal` sú Europe/Bratislava miestny čas
// (predtým `hourUtc`/`minuteUtc`, doslova UTC) — literály nižšie sú UTC
// okamihy zodpovedajúce miestnemu "01:00"/"00:00" na dátume 2026-07-29
// (letný čas, offset +2).
const NOW = new Date("2026-07-28T23:00:00Z"); // 2026-07-29 01:00 Europe/Bratislava
const PRED_HODINOU = new Date("2026-07-28T22:00:00Z"); // 2026-07-29 00:00 Europe/Bratislava
const NASLEDUJUCI_DEN = new Date("2026-07-29T23:00:00Z"); // 2026-07-30 01:00 Europe/Bratislava

function fakeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    name: "fake-job",
    schedule: { kind: "daily", hourLocal: 1, minuteLocal: 0 },
    run: () => Promise.resolve({ detail: { ok: true } }),
    ...overrides,
  };
}

it("splatná úloha dostane 'running' riadok a po dobehnutí sa zapíše ako 'success' s detailom", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;

  await tick(ctx.db, [fakeJob()], NOW);

  const [runs] = await listLatestJobRuns(ctx.db);
  expect(runs).toMatchObject({ jobName: "fake-job", status: "success", detail: { ok: true } });
  expect(runs?.finishedAt).not.toBeNull();
});

it("nesplatná úloha (pred naplánovanou hodinou) nezapíše žiadny riadok", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;

  await tick(ctx.db, [fakeJob()], PRED_HODINOU);

  expect(await listLatestJobRuns(ctx.db)).toEqual([]);
});

it("zlyhaná úloha (vyhodená výnimka) sa zapíše ako 'failure' s chybovou správou, nikdy neprejde ďalej", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;

  await tick(
    ctx.db,
    [
      fakeJob({
        run: () => Promise.reject(new Error("simulované zlyhanie")),
      }),
    ],
    NOW,
  );

  const [run] = await listLatestJobRuns(ctx.db);
  expect(run).toMatchObject({ status: "failure", errorMessage: "simulované zlyhanie" });
});

it("druhý tick v ten istý deň úlohu nezopakuje", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const job = fakeJob();

  await tick(ctx.db, [job], NOW);
  await tick(ctx.db, [job], new Date("2026-07-29T14:00:00Z"));

  const all = await ctx.db.select().from(jobRuns);
  expect(all).toHaveLength(1);
});

it("ďalší SLOVENSKÝ kalendárny deň úlohu znova spustí", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const job = fakeJob();

  await tick(ctx.db, [job], NOW);
  await tick(ctx.db, [job], NASLEDUJUCI_DEN);

  const all = await ctx.db.select().from(jobRuns);
  expect(all).toHaveLength(2);
});

// Deterministický dôkaz vzájomného vylúčenia (rovnaký vzor ako
// catalog-ingest-lock.integration.test.ts): manuálne podrží ROVNAKÝ advisory
// zámok, aký `tick()` berie ako prvý príkaz svojej transakcie, z DRUHÉHO
// pripojenia. Kým je zámok držaný, súbežný `tick()` sa musí zaseknúť presne
// na ňom — vloží svoj "running" riadok AŽ PO uvoľnení, nikdy skôr.
it("dva súbežné tick() volania sa navzájom serializujú cez pg_advisory_xact_lock, nikdy nezdvojnásobia beh", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("Integračné testy potrebujú DATABASE_URL");
  }
  const lockHolder = new pg.Client({ connectionString: databaseUrl });
  await lockHolder.connect();
  await lockHolder.query("select pg_advisory_lock($1)", [SCHEDULER_ADVISORY_LOCK_KEY]);

  try {
    const blockedTick = tick(ctx.db, [fakeJob()], NOW);

    // Dá zaseknutému ticku dosť času dôjsť až k zámku — zámok drží
    // `lockHolder`, takže "príliš neskoro" tu nehrozí.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await listLatestJobRuns(ctx.db)).toEqual([]);

    await lockHolder.query("select pg_advisory_unlock($1)", [SCHEDULER_ADVISORY_LOCK_KEY]);
    await blockedTick;

    const [run] = await listLatestJobRuns(ctx.db);
    expect(run?.status).toBe("success");
  } finally {
    await lockHolder.end();
  }
});
