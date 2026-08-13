import { afterEach, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { RESTOCK_JOB_NAME } from "../src/modules/restock/constants.js";
import { withCleanDb } from "./helpers/db.js";
import { waitForJobRunSettled } from "./helpers/job-run.js";

// issue 413 (review finding — reviewer's 🟡 #2): every one of the six
// run-now automations shares ONE core (`startRunNow`), already covered
// generically by `run-now.integration.test.ts`, but only 2 of 6 routes had
// an HTTP-level test proving the ACTUAL route is wired to the new 202/busy
// contract (not still the old synchronous shape). This file closes that gap
// for `restock` — separate from `restock-run.integration.test.ts` (business
// logic, calls `runRestock` directly) so this one file stays a thin,
// route-only proof.
//
// A completely EMPTY database (no seeded products/variants/supplier_stock)
// is deliberate, not an oversight: `runRestockLocked` (`restock/run.ts`)
// returns `{status:"nothing_to_do"}` the moment `selectRestockCandidates`
// finds zero candidates — BEFORE it ever calls `importToShoptet` (which
// defaults to the REAL `runShoptetImportIsolated`, `.claude/rules/
// testing.md`'s "never touch a real external system in a test" rule). No
// fixture, no `createApp(... {restock: {...}})` override needed — the
// empty-DB short-circuit is what keeps this test from ever reaching
// Shoptet.
const HESLO = "test-heslo-abc";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot() {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({
    email: "pouzivatel@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Test",
    role: "manazer",
  });
  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "pouzivatel@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db };
}

it("POST /api/restock/run-now vráti 202 {ok:true,started:true} HNEĎ a job_run dobehne 'nothing_to_do'", async () => {
  const { app, cookie, db } = await boot();

  const res = await app.request("/api/restock/run-now", { method: "POST", headers: { cookie } });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { ok: boolean; started: boolean };
  expect(body).toEqual({ ok: true, started: true });

  const finished = await waitForJobRunSettled(db, RESTOCK_JOB_NAME);
  expect(finished.status).toBe("success");
  expect(finished.detail).toEqual({ status: "nothing_to_do", overLimit: 0 });
});

it("druhý POST PRESNE počas prebiehajúceho behu vráti 200 {ok:false,error} 'beh už prebieha'", async () => {
  const { app, cookie, db } = await boot();

  const first = app.request("/api/restock/run-now", { method: "POST", headers: { cookie } });
  const second = await app.request("/api/restock/run-now", { method: "POST", headers: { cookie } });
  expect(second.status).toBe(200);
  const secondBody = (await second.json()) as { ok: boolean; error: string };
  expect(secondBody.ok).toBe(false);
  expect(secondBody.error).toContain("Beh už prebieha");

  const firstResponse = await first;
  expect(firstResponse.status).toBe(202);
  await waitForJobRunSettled(db, RESTOCK_JOB_NAME);
});
