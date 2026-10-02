// issue 589 (majiteľ: "vie sa to refreshovat kazdych 15 min") — registrácia
// `ordersImportJob` (15-min kadencia cez nový `everyMinutes` rozvrh) a
// retencia surových exportov objednávok (`pruneRawOrdersJob`), ktorá pri 4×
// častejšom importe nesmie nechať `/data/orders-raw` narásť o rád. Joby :50
// (issue 122) a :55 (issue 123) ostávajú hodinové — test to drží, aby ich
// zmena kadencie importu omylom nestiahla so sebou.
import { mkdir, mkdtemp, rm, utimes, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Database } from "../../db/client.js";
import type { RunOrdersIngest } from "../orders/ingest.js";
import {
  ORDERS_IMPORT_JOB_NAME,
  ORDERS_RAW_KEEP_DAYS,
  orderNoteWritebackJob,
  ordersImportJob,
  pruneRawOrdersJob,
  shoptetWritebackJob,
} from "./jobs.js";
import { isDue } from "./scheduler.js";

const DB = {} as Database;
const DAY_MS = 24 * 60 * 60 * 1000;

it("issue 589: ordersImportJob beží každých 15 minút (everyMinutes 15), meno a job_run ostávajú 'orders-import'", () => {
  const job = ordersImportJob(undefined);
  expect(job.name).toBe(ORDERS_IMPORT_JOB_NAME);
  expect(job.name).toBe("orders-import");
  expect(job.schedule).toEqual({ kind: "everyMinutes", minutes: 15 });
});

it("issue 589: ordersImportJob je za jednu UTC hodinu splatný presne 4× (simulácia 5-min tickov plánovača)", () => {
  const job = ordersImportJob(undefined);
  let lastRun: { startedAt: Date } | null = { startedAt: new Date("2026-10-02T09:59:00Z") };
  let runs = 0;
  for (let minute = 0; minute < 60; minute += 5) {
    const now = new Date(Date.UTC(2026, 9, 2, 10, minute));
    if (isDue(job.schedule, now, lastRun)) {
      runs += 1;
      lastRun = { startedAt: now };
    }
  }
  expect(runs).toBe(4);
});

it("issue 589: ordersImportJob stále volá injektovaný ingest a jeho výsledok dá do detailu", async () => {
  const now = new Date("2026-10-02T10:15:00Z");
  const calls: Date[] = [];
  const runOrdersIngest = ((at: Date) => {
    calls.push(at);
    return Promise.resolve({ status: "accepted" });
  }) as unknown as RunOrdersIngest;
  const outcome = await ordersImportJob(runOrdersIngest).run(DB, now);
  expect(calls).toEqual([now]);
  expect(outcome.detail).toEqual({ status: "accepted" });
});

it("issue 589: spätné zápisy :50 (issue 122) a :55 (issue 123) ostávajú hodinové, nezmenené", () => {
  expect(shoptetWritebackJob(undefined).schedule).toEqual({ kind: "hourly", minuteUtc: 50 });
  expect(orderNoteWritebackJob(undefined).schedule).toEqual({ kind: "hourly", minuteUtc: 55 });
});

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function rawFile(root: string, name: string, ageDays: number, now: Date): Promise<string> {
  const sub = join(root, "2026", "10");
  await mkdir(sub, { recursive: true });
  const file = join(sub, name);
  await writeFile(file, "x");
  const at = new Date(now.getTime() - ageDays * DAY_MS);
  await utimes(file, at, at);
  return file;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

it("issue 589: retencia surových exportov objednávok je 7 dní (96 behov/deň × 7 ≈ dnešných 30 dní × 24)", () => {
  expect(ORDERS_RAW_KEEP_DAYS).toBe(7);
});

it("issue 589: pruneRawOrdersJob bez explicitného keepDays zmaže 8-dňový export a nechá 6-dňový", async () => {
  dir = await mkdtemp(join(tmpdir(), "orders-raw-589-"));
  const now = new Date("2026-10-02T00:10:00Z");
  const old = await rawFile(dir, "old.csv.gz", 8, now);
  const recent = await rawFile(dir, "recent.csv.gz", 6, now);
  const outcome = await pruneRawOrdersJob(dir).run(DB, now);
  expect(outcome.detail).toEqual({ removed: 1 });
  expect(await exists(old)).toBe(false);
  expect(await exists(recent)).toBe(true);
});
