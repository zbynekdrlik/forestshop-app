import { afterEach, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { PAIRING_SEARCH_JOB_NAME } from "../src/modules/pairing-search/constants.js";
import { withCleanDb } from "./helpers/db.js";
import { waitForJobRunSettled } from "./helpers/job-run.js";

// issue 413 (review finding — reviewer's 🟡 #2): closes the missing
// HTTP-level run-now coverage for `pairing-search`, same reasoning as
// `restock-run-now-http.integration.test.ts` — the shared `startRunNow`
// core is already covered generically, this proves the ROUTE itself is
// wired to the 202/busy contract.
//
// A completely EMPTY database is deliberate: `runPairingSearchLocked`
// (`pairing-search/run.ts`) iterates `selectEligibleProducts(db)` and never
// enters the loop body (the only place `searchClient` — defaulting to the
// REAL `new SearchClient()`, `.claude/rules/testing.md`'s "never touch a
// real external system in a test" rule — is actually used) when there are
// zero eligible products. No fixture needed — the empty-DB short-circuit is
// what keeps this test from ever reaching a live search provider.
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

it("POST /api/pairing-search/run-now vráti 202 {ok:true,started:true} HNEĎ a job_run dobehne s eligible:0", async () => {
  const { app, cookie, db } = await boot();

  const res = await app.request("/api/pairing-search/run-now", { method: "POST", headers: { cookie } });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { ok: boolean; started: boolean };
  expect(body).toEqual({ ok: true, started: true });

  const finished = await waitForJobRunSettled(db, PAIRING_SEARCH_JOB_NAME);
  expect(finished.status).toBe("success");
  const detail = finished.detail as { eligible: number; processed: number };
  expect(detail.eligible).toBe(0);
  expect(detail.processed).toBe(0);
});

it("druhý POST PRESNE počas prebiehajúceho behu vráti 200 {ok:false,error} 'beh už prebieha'", async () => {
  const { app, cookie, db } = await boot();

  const first = app.request("/api/pairing-search/run-now", { method: "POST", headers: { cookie } });
  const second = await app.request("/api/pairing-search/run-now", { method: "POST", headers: { cookie } });
  expect(second.status).toBe(200);
  const secondBody = (await second.json()) as { ok: boolean; error: string };
  expect(secondBody.ok).toBe(false);
  expect(secondBody.error).toContain("Beh už prebieha");

  const firstResponse = await first;
  expect(firstResponse.status).toBe(202);
  await waitForJobRunSettled(db, PAIRING_SEARCH_JOB_NAME);
});
