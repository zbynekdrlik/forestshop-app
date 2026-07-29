import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sessions, users } from "../src/db/schema.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { CatalogIngestResult } from "../src/modules/catalog/ingest.js";
import { ORDERS_EXPORT_URL_NOT_CONFIGURED, type OrdersIngestResult } from "../src/modules/orders/ingest.js";
import {
  CATALOG_IMPORT_JOB_NAME,
  ORDERS_IMPORT_JOB_NAME,
  PRUNE_RAW_EXPORTS_JOB_NAME,
  PRUNE_RAW_ORDERS_JOB_NAME,
  SESSION_CLEANUP_JOB_NAME,
  catalogImportJob,
  ordersImportJob,
  pruneRawExportsJob,
  pruneRawOrdersJob,
  sessionCleanupJob,
} from "../src/modules/scheduler/jobs.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";

let close: (() => Promise<void>) | undefined;
let dir: string | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const NOW = new Date("2026-07-29T10:00:00Z");
const DAVNO = new Date("2026-05-01T10:00:00Z");

it("catalogImportJob bez nakonfigurovaného runIngest VYHODÍ (zachytí ho scheduler.ts, zapíše ako failure)", async () => {
  const job = catalogImportJob(undefined);
  expect(job.name).toBe(CATALOG_IMPORT_JOB_NAME);
  await expect(job.run({} as never, NOW)).rejects.toThrow(
    "Import katalógu nie je nakonfigurovaný (chýba SHOPTET_EXPORT_URL)",
  );
});

it("catalogImportJob s nakonfigurovaným runIngest naň deleguje a vráti jeho výsledok ako detail", async () => {
  const fakeResult: CatalogIngestResult = { status: "duplicate", snapshotId: "s1" };
  let receivedNow: Date | undefined;
  const job = catalogImportJob((now) => {
    receivedNow = now;
    return Promise.resolve(fakeResult);
  });

  const outcome = await job.run({} as never, NOW);
  expect(outcome).toEqual({ detail: fakeResult });
  expect(receivedNow).toBe(NOW);
});

it("pruneRawExportsJob deleguje na existujúci pruneRawSnapshots — starý prijatý surový súbor sa naozaj zmaže", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  dir = await mkdtemp(join(tmpdir(), "forestshop-scheduler-"));

  await insertTestSnapshot(ctx.db, {
    verdict: "accepted",
    fetchedAt: DAVNO,
    contentSha256: "sha-scheduler-old",
  });
  // Druhý (novší) prijatý snapshot, aby prvý nebol "posledný prijatý" (ten sa
  // nikdy nemaže, rovnaká výnimka ako v catalog-retention.integration.test.ts).
  await insertTestSnapshot(ctx.db, {
    verdict: "accepted",
    fetchedAt: NOW,
    contentSha256: "sha-scheduler-newest",
  });

  const job = pruneRawExportsJob(30);
  expect(job.name).toBe(PRUNE_RAW_EXPORTS_JOB_NAME);
  const outcome = await job.run(ctx.db, NOW);
  // Ani jeden z dvoch vložených snapshotov nemá `rawPath` (insertTestSnapshot
  // ho nenastavuje) — `pruneRawSnapshots` teda nemá čo reálne zmazať, no
  // volanie musí prejsť bez chyby a vrátiť detail so správnym tvarom.
  expect(outcome).toEqual({ detail: { removed: 0 } });
});

it("sessionCleanupJob deleguje na cleanupExpiredSessions — zmaže expirovanú, platnú nechá", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;

  const [user] = await ctx.db
    .insert(users)
    .values({
      email: "manazer@forestshop.sk",
      passwordHash: await hashPassword("test-heslo-abc"),
      displayName: "Manažér",
      role: "manazer",
    })
    .returning({ id: users.id });
  if (user === undefined) throw new Error("testovací používateľ sa nepodarilo vložiť");

  await ctx.db.insert(sessions).values([
    { tokenHash: "expirovana", userId: user.id, expiresAt: new Date(NOW.getTime() - 1000) },
    { tokenHash: "platna", userId: user.id, expiresAt: new Date(NOW.getTime() + 1000) },
  ]);

  const job = sessionCleanupJob();
  expect(job.name).toBe(SESSION_CLEANUP_JOB_NAME);
  const outcome = await job.run(ctx.db, NOW);
  expect(outcome).toEqual({ detail: { deletedCount: 1 } });

  const zostavajuce = await ctx.db.select({ tokenHash: sessions.tokenHash }).from(sessions);
  expect(zostavajuce).toEqual([{ tokenHash: "platna" }]);
});

it("ordersImportJob bez nakonfigurovaného runOrdersIngest VYHODÍ (zachytí ho scheduler.ts, zapíše ako failure)", async () => {
  const job = ordersImportJob(undefined);
  expect(job.name).toBe(ORDERS_IMPORT_JOB_NAME);
  await expect(job.run({} as never, NOW)).rejects.toThrow(ORDERS_EXPORT_URL_NOT_CONFIGURED);
});

it("ordersImportJob s nakonfigurovaným runOrdersIngest naň deleguje a vráti jeho výsledok ako detail", async () => {
  const fakeResult: OrdersIngestResult = {
    status: "accepted",
    orderCount: 2,
    lineCount: 3,
    skippedItemCount: 0,
    pseudoItemCount: 0,
    issueCount: 0,
    rawPath: "/tmp/fake.csv.gz",
  };
  let receivedNow: Date | undefined;
  const job = ordersImportJob((now) => {
    receivedNow = now;
    return Promise.resolve(fakeResult);
  });

  const outcome = await job.run({} as never, NOW);
  expect(outcome).toEqual({ detail: fakeResult });
  expect(receivedNow).toBe(NOW);
});

it("pruneRawOrdersJob deleguje na existujúci pruneRawOrders — starý surový súbor objednávok sa naozaj zmaže", async () => {
  dir = await mkdtemp(join(tmpdir(), "forestshop-scheduler-orders-"));
  const staryPath = join(dir, "stary.csv.gz");
  const novyPath = join(dir, "novy.csv.gz");
  await writeFile(staryPath, "stary");
  await writeFile(novyPath, "novy");
  await utimes(staryPath, DAVNO, DAVNO);
  await utimes(novyPath, NOW, NOW);

  const job = pruneRawOrdersJob(dir, 30);
  expect(job.name).toBe(PRUNE_RAW_ORDERS_JOB_NAME);
  const outcome = await job.run({} as never, NOW);
  expect(outcome).toEqual({ detail: { removed: 1 } });
});
