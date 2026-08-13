import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { jobRuns } from "../src/db/schema.js";
import { cleanOrphanedJobRuns, ORPHANED_JOB_RUN_MESSAGE } from "../src/modules/scheduler/startup-cleanup.js";
import { withCleanDb } from "./helpers/db.js";

// issue 413 (nález b): appka reštart (SIGTERM/SIGKILL pri deploy) zabije
// rozbehnutý beh a jeho `job_run` riadok ostane navždy "running" — tieto
// testy overujú `cleanOrphanedJobRuns`, ktoré `index.ts` volá RAZ pri
// štarte, HNEĎ po migráciách.

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

it("označí 'running' riadok STARŠÍ než štart procesu ako failure s vysvetľujúcou správou", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const [inserted] = await ctx.db
    .insert(jobRuns)
    .values({ jobName: "orphaned-before-restart", startedAt: new Date("2026-08-13T09:00:00Z"), status: "running" })
    .returning({ id: jobRuns.id });
  const runId = inserted?.id;
  expect(runId).toBeDefined();

  const processStartedAt = new Date("2026-08-13T09:12:00Z");
  const count = await cleanOrphanedJobRuns(ctx.db, processStartedAt);
  expect(count).toBe(1);

  const [row] = await ctx.db.select().from(jobRuns).where(eq(jobRuns.id, runId ?? ""));
  expect(row?.status).toBe("failure");
  expect(row?.errorMessage).toBe(ORPHANED_JOB_RUN_MESSAGE);
  expect(row?.finishedAt?.toISOString()).toBe(processStartedAt.toISOString());
});

it("NEDOTKNE SA 'running' riadku vloženého AŽ PO štarte procesu (nový, skutočne bežiaci beh)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const processStartedAt = new Date("2026-08-13T09:12:00Z");
  const [inserted] = await ctx.db
    .insert(jobRuns)
    .values({ jobName: "genuinely-running-now", startedAt: new Date("2026-08-13T09:15:00Z"), status: "running" })
    .returning({ id: jobRuns.id });
  const runId = inserted?.id;

  const count = await cleanOrphanedJobRuns(ctx.db, processStartedAt);
  expect(count).toBe(0);

  const [row] = await ctx.db.select().from(jobRuns).where(eq(jobRuns.id, runId ?? ""));
  expect(row?.status).toBe("running");
  expect(row?.errorMessage).toBeNull();
});

it("NEDOTKNE SA riadku, ktorý už má konečný stav (success/failure)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const [inserted] = await ctx.db
    .insert(jobRuns)
    .values({
      jobName: "already-succeeded",
      startedAt: new Date("2026-08-13T08:00:00Z"),
      finishedAt: new Date("2026-08-13T08:05:00Z"),
      status: "success",
      detail: { ok: true },
    })
    .returning({ id: jobRuns.id });
  const runId = inserted?.id;

  const count = await cleanOrphanedJobRuns(ctx.db, new Date("2026-08-13T09:00:00Z"));
  expect(count).toBe(0);

  const [row] = await ctx.db.select().from(jobRuns).where(eq(jobRuns.id, runId ?? ""));
  expect(row?.status).toBe("success");
  expect(row?.detail).toEqual({ ok: true });
});

it("vyčistí VIACERO osirotených riadkov naraz, každý s vlastným jobName", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(jobRuns).values([
    { jobName: "orphan-a", startedAt: new Date("2026-08-13T08:00:00Z"), status: "running" },
    { jobName: "orphan-b", startedAt: new Date("2026-08-13T08:30:00Z"), status: "running" },
  ]);

  const count = await cleanOrphanedJobRuns(ctx.db, new Date("2026-08-13T09:00:00Z"));
  expect(count).toBe(2);
});
