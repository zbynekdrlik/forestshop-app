// issue 598: koľko požiadaviek poslal KAŽDÝ beh na forestshop.sk, sa zapíše do
// `job_run.detail` (`shoptetRequests`, `shoptetBlocked`), aby bolo vidno, kto
// e-shop zaťažuje (Shoptet WAF od 21. 10. 2026 blokuje IP servera). Platí pre
// naplánovaný beh (`tick`) aj pre `startRunNow` (Spustiť teraz / reťaz /
// opakovanie po bloku), aj pre ZLYHANÝ beh.

import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { jobRuns } from "../src/db/schema.js";
import { startRunNow } from "../src/modules/scheduler/run-now.js";
import { tick } from "../src/modules/scheduler/scheduler.js";
import type { ScheduledJob } from "../src/modules/scheduler/types.js";
import { shoptetFetch } from "../src/modules/shoptet-http/fetch.js";
import { withCleanDb } from "./helpers/db.js";
import { waitForJobRunSettled } from "./helpers/job-run.js";

const BLOCK_PAGE = readFileSync(new URL("../src/modules/shoptet-http/fixtures/shoptet-block-page.html", import.meta.url), "utf8");
const NOW = new Date("2026-10-26T03:05:00Z"); // 04:05 Europe/Bratislava
const TEST_RUN_NOW_TALLY_LOCK_KEY = 787_878_102;

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  await close?.();
  close = undefined;
});

function job(run: ScheduledJob["run"]): ScheduledJob {
  return { name: "tally-job", schedule: { kind: "daily", hourLocal: 4, minuteLocal: 0 }, run };
}

it("naplánovaný beh: počet požiadaviek na e-shop sa pridá k detailu úspešného behu", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("ok", { status: 200 }))));

  await tick(ctx.db, [job(async () => {
    await shoptetFetch("https://www.forestshop.sk/a/", {}, "a");
    await shoptetFetch("https://www.forestshop.sk/b/", {}, "b");
    return { detail: { status: "ok" } };
  })], NOW);

  const [row] = await ctx.db.select().from(jobRuns).where(eq(jobRuns.jobName, "tally-job"));
  expect(row?.status).toBe("success");
  expect(row?.detail).toEqual({ status: "ok", shoptetRequests: 2 });
});

it("naplánovaný beh, ktorý ZLYHÁ na bloku: detail nesie počty aj pri failure", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(() => {
    call += 1;
    return Promise.resolve(call === 1 ? new Response("ok", { status: 200 }) : new Response(BLOCK_PAGE, { status: 403 }));
  }));

  await tick(ctx.db, [job(async () => {
    await shoptetFetch("https://www.forestshop.sk/a/", {}, "export");
    await shoptetFetch("https://www.forestshop.sk/b/", {}, "export");
    return { detail: null };
  })], NOW);

  const [row] = await ctx.db.select().from(jobRuns).where(eq(jobRuns.jobName, "tally-job"));
  expect(row?.status).toBe("failure");
  expect(row?.errorMessage).toMatch(/^shoptet_blocked:/);
  expect(row?.detail).toEqual({ shoptetRequests: 2, shoptetBlocked: 1 });
});

it("beh bez jedinej požiadavky na e-shop detail nemení", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await tick(ctx.db, [job(() => Promise.resolve({ detail: { status: "nothing_to_do" } }))], NOW);
  const [row] = await ctx.db.select().from(jobRuns).where(eq(jobRuns.jobName, "tally-job"));
  expect(row?.detail).toEqual({ status: "nothing_to_do" });
});

it("startRunNow: počty sa zapíšu do job_run riadku spusteného behu", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("ok", { status: 200 }))));

  await startRunNow(
    ctx.db,
    {
      jobName: "tally-run-now",
      lockKey: TEST_RUN_NOW_TALLY_LOCK_KEY,
      run: async () => {
        await shoptetFetch("https://www.forestshop.sk/a/", {}, "a");
        return { status: "ok" };
      },
    },
    NOW,
    () => undefined,
  );

  const settled = await waitForJobRunSettled(ctx.db, "tally-run-now");
  expect(settled.status).toBe("success");
  expect(settled.detail).toEqual({ status: "ok", shoptetRequests: 1 });
});
