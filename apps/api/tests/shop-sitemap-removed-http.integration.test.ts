import { afterEach, expect, it } from "vitest";
import { jobRuns, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { withCleanDb } from "./helpers/db.js";

// issue 598 (ROZHODNUTÉ 20. 11. 2026, možnosť 1): `shop-sitemap` (sitemap.xml +
// HTTP sonda hádaných adries na forestshop.sk) spúšťal ~4 h blok IP servera
// Shoptetom — blok sa posunul presne s jeho slotom (04:05 → 08:35). Majiteľ
// odkazy na vypnuté produkty nepotrebuje, job je odstránený úplne: ani denný
// beh, ani ručné „Spustiť teraz" už na e-shop nechodí.
const HESLO = "test-heslo-abc";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

it("issue 598: POST /api/shop-sitemap/run-now už neexistuje a nezaloží job_run", async () => {
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

  const res = await app.request("/api/shop-sitemap/run-now", { method: "POST", headers: { cookie } });
  expect(res.status).toBe(404);
  const status = await app.request("/api/shop-sitemap/status", { headers: { cookie } });
  expect(status.status).toBe(404);

  await new Promise((r) => setTimeout(r, 200));
  expect(await ctx.db.select().from(jobRuns)).toEqual([]);
});
