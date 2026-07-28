import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { users } from "../src/db/schema.js";
import { withCleanDb } from "./helpers/db.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

const HESLO = "test-heslo-abc";     // testovacie údaje, nie tajomstvo
const ZLE_HESLO = "nespravne";

async function boot() {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({
    email: "manazer@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Manažér",
    role: "manazer",
  });
  return createApp(ctx.db, { cookieSecure: false });
}

it("GET /api/version vráti verziu aj bez prihlásenia", async () => {
  const app = await boot();
  const res = await app.request("/api/version");
  expect(res.status).toBe(200);
  expect(((await res.json()) as { version: string }).version).toMatch(/^\d+\.\d+\.\d+/);
});

it("GET /api/me bez prihlásenia vráti 401", async () => {
  const app = await boot();
  expect((await app.request("/api/me")).status).toBe(401);
});

it("prihlásenie nastaví cookie a /api/me potom vráti používateľa", async () => {
  const app = await boot();
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("fs_session=");
  expect(cookie).toContain("HttpOnly");

  const me = await app.request("/api/me", { headers: { cookie: cookie.split(";")[0] ?? "" } });
  expect(me.status).toBe(200);
  expect((await me.json()) as { role: string }).toMatchObject({ role: "manazer" });
});

it("zlé heslo vráti 401 a nenastaví cookie", async () => {
  const app = await boot();
  const res = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: ZLE_HESLO }),
  });
  expect(res.status).toBe(401);
  expect(res.headers.get("set-cookie")).toBeNull();
});

it("telo bez e-mailu vráti 400", async () => {
  const app = await boot();
  const res = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ZLE_HESLO }),
  });
  expect(res.status).toBe(400);
});
