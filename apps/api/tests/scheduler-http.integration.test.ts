import { afterEach, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { tick } from "../src/modules/scheduler/scheduler.js";
import type { ScheduledJob } from "../src/modules/scheduler/types.js";
import { withCleanDb } from "./helpers/db.js";

const HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo
const NOW = new Date("2026-07-29T01:00:00Z");

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot(role: UserRole) {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({
    email: "pouzivatel@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Test",
    role,
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

it("bez prihlásenia vráti 401", async () => {
  const { app } = await boot("manazer");
  const res = await app.request("/api/scheduler/runs");
  expect(res.status).toBe(401);
});

// Samostatný `it()` na rolu (nie slučka v jednom teste) — `withCleanDb()` berie
// EXKLUZÍVNY session-scoped advisory zámok (testing.md, TEST_DB_ISOLATION_LOCK_KEY),
// druhé volanie `boot()` v tom istom teste by naň čakalo naveky, lebo prvé sa
// uvoľní až v `afterEach`, ktoré počas behu testu ešte nedobehlo. Rovnaký vzor
// ako `catalog-http-ingest.integration.test.ts`'s samostatné testy pre "citanie"/"sef".
it("rola citanie nesmie vidieť plánovač", async () => {
  const { app, cookie } = await boot("citanie");
  const res = await app.request("/api/scheduler/runs", { headers: { cookie } });
  expect(res.status).toBe(403);
});

it("rola sef tiež nesmie vidieť plánovač — obe neprivilegované role sú overené, nielen jedna", async () => {
  const { app, cookie } = await boot("sef");
  const res = await app.request("/api/scheduler/runs", { headers: { cookie } });
  expect(res.status).toBe(403);
});

it("manazer vidí posledný beh každej úlohy", async () => {
  const { app, cookie, db } = await boot("manazer");

  const job: ScheduledJob = {
    name: "test-job",
    schedule: { hourUtc: 1, minuteUtc: 0 },
    run: () => Promise.resolve({ detail: { removed: 3 } }),
  };
  await tick(db, [job], NOW);

  const res = await app.request("/api/scheduler/runs", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: unknown[] };
  expect(body.items).toEqual([
    expect.objectContaining({
      jobName: "test-job",
      status: "success",
      detail: { removed: 3 },
      errorMessage: null,
    }),
  ]);
});

it("keď zatiaľ nič nebežalo, vráti prázdny zoznam (nie chybu)", async () => {
  const { app, cookie } = await boot("admin");
  const res = await app.request("/api/scheduler/runs", { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ items: [] });
});
