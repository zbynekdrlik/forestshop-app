import { afterEach, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { withCleanDb } from "./helpers/db.js";

// issue 387 E7: `GET`/`PUT /api/pairing-review/state-writeback-enabled` —
// vyčlenené OD `pairing-review-decisions-http.integration.test.ts` (E6, už
// na 316 riadkoch), aby ani jeden súbor nenarástol cez eslint `max-lines:
// 400` (`.claude/rules/testing.md`'s zavedený vzor).

const HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot(role: UserRole) {
  const ctx = await withCleanDb();
  close = ctx.close;
  const [pouzivatel] = await ctx.db
    .insert(users)
    .values({ email: "manazer@forestshop.sk", passwordHash: await hashPassword(HESLO), displayName: "Manažér", role })
    .returning({ id: users.id });
  if (pouzivatel === undefined) throw new Error("testovací používateľ sa nepodarilo vložiť");

  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie };
}

it("GET vráti enabled=false hneď po migrácii (bezpečný default — nikdy zapnuté bez výslovného zásahu)", async () => {
  const { app, cookie } = await boot("citanie");
  const res = await app.request("/api/pairing-review/state-writeback-enabled", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { enabled: boolean };
  expect(body.enabled).toBe(false);
});

it("rola citanie NESMIE prepnúť Štart/Stop (403)", async () => {
  const { app, cookie } = await boot("citanie");
  const res = await app.request("/api/pairing-review/state-writeback-enabled", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(res.status).toBe(403);
});

it("manazer prepne Štart/Stop a GET to hneď odzrkadlí", async () => {
  const { app, cookie } = await boot("manazer");
  const put = await app.request("/api/pairing-review/state-writeback-enabled", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(put.status).toBe(200);

  const res = await app.request("/api/pairing-review/state-writeback-enabled", { headers: { cookie } });
  const body = (await res.json()) as { enabled: boolean };
  expect(body.enabled).toBe(true);
});
