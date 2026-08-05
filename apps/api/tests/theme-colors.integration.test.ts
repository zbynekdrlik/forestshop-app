import { afterEach, expect, it } from "vitest";
import { themeColors, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { THEME_COLOR_KINDS } from "../src/modules/theme-colors/registry.js";
import { withCleanDb } from "./helpers/db.js";

// issue 264: obrazovka "Farby aplikácie" (koliesko v Topbar) cez HTTP.
const HESLO = "test-heslo-abc";

const DEFAULT_VALUES = {
  "chip-done-bg": THEME_COLOR_KINDS["chip-done-bg"].defaultValue,
  "chip-done-text": THEME_COLOR_KINDS["chip-done-text"].defaultValue,
  "chip-todo-bg": THEME_COLOR_KINDS["chip-todo-bg"].defaultValue,
  "chip-todo-text": THEME_COLOR_KINDS["chip-todo-text"].defaultValue,
  "chip-active-bg": THEME_COLOR_KINDS["chip-active-bg"].defaultValue,
  "chip-active-text": THEME_COLOR_KINDS["chip-active-text"].defaultValue,
};

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
    displayName: "Test Používateľ",
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

function jsonRequest(cookie: string, method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

it("zoznam vráti šesť predvolených farieb, kým sa nič neuložilo", async () => {
  const { app, cookie } = await boot("manazer");
  const res = await app.request("/api/theme-colors", { headers: { cookie } });
  expect(res.status).toBe(200);
  const payload = (await res.json()) as { colors: { key: string; value: string; defaultValue: string; isCustomized: boolean }[] };
  expect(payload.colors).toHaveLength(6);
  const done = payload.colors.find((c) => c.key === "chip-done-bg");
  expect(done?.isCustomized).toBe(false);
  expect(done?.value).toBe(THEME_COLOR_KINDS["chip-done-bg"].defaultValue);
  expect(done?.defaultValue).toBe(THEME_COLOR_KINDS["chip-done-bg"].defaultValue);
});

it("čítanie je dostupné bez prihlásenia — 401", async () => {
  const { app } = await boot("manazer");
  const res = await app.request("/api/theme-colors");
  expect(res.status).toBe(401);
});

it("uloženie zmení farby; vrátenie predvolených ich vráti späť", async () => {
  const { app, cookie, db } = await boot("manazer");

  const values = { ...DEFAULT_VALUES, "chip-done-bg": "#123456" };
  const save = await app.request("/api/theme-colors", jsonRequest(cookie, "PUT", { values }));
  expect(await save.json()).toEqual({ ok: true });

  const afterSave = (await (await app.request("/api/theme-colors", { headers: { cookie } })).json()) as {
    colors: { key: string; value: string; isCustomized: boolean }[];
  };
  const doneAfterSave = afterSave.colors.find((c) => c.key === "chip-done-bg");
  expect(doneAfterSave?.value).toBe("#123456");
  expect(doneAfterSave?.isCustomized).toBe(true);

  const reset = await app.request("/api/theme-colors/reset", jsonRequest(cookie, "POST"));
  expect(await reset.json()).toEqual({ ok: true });
  expect(await db.select().from(themeColors)).toHaveLength(0);

  const afterReset = (await (await app.request("/api/theme-colors", { headers: { cookie } })).json()) as {
    colors: { key: string; value: string; isCustomized: boolean }[];
  };
  const doneAfterReset = afterReset.colors.find((c) => c.key === "chip-done-bg");
  expect(doneAfterReset?.value).toBe(THEME_COLOR_KINDS["chip-done-bg"].defaultValue);
  expect(doneAfterReset?.isCustomized).toBe(false);
});

it("neplatný kód farby sa NEULOŽÍ (200 s ok:false, žiadny riadok navyše)", async () => {
  const { app, cookie, db } = await boot("manazer");
  const values = { ...DEFAULT_VALUES, "chip-done-bg": "not-a-color" };
  const res = await app.request("/api/theme-colors", jsonRequest(cookie, "PUT", { values }));
  expect(res.status).toBe(200);
  const payload = (await res.json()) as { ok: boolean; error: string };
  expect(payload.ok).toBe(false);
  expect(payload.error).toContain("Vybavený dodávateľ — pozadie");
  expect(await db.select().from(themeColors)).toHaveLength(0);
});

it("chýbajúci kľúč sa NEULOŽÍ ani čiastočne (all-or-nothing)", async () => {
  const { app, cookie, db } = await boot("manazer");
  const partial = Object.fromEntries(Object.entries(DEFAULT_VALUES).filter(([key]) => key !== "chip-active-text"));
  const res = await app.request("/api/theme-colors", jsonRequest(cookie, "PUT", { values: partial }));
  const payload = (await res.json()) as { ok: boolean; error: string };
  expect(payload.ok).toBe(false);
  expect(await db.select().from(themeColors)).toHaveLength(0);
});

it("rola „citanie“ farby upraviť nesmie", async () => {
  const { app, cookie, db } = await boot("citanie");
  const res = await app.request("/api/theme-colors", jsonRequest(cookie, "PUT", { values: DEFAULT_VALUES }));
  expect(res.status).toBe(403);
  expect(await db.select().from(themeColors)).toHaveLength(0);
});

it("rola „citanie“ nesmie ani resetovať, ale SMIE čítať", async () => {
  const { app, cookie } = await boot("citanie");
  const resetRes = await app.request("/api/theme-colors/reset", jsonRequest(cookie, "POST"));
  expect(resetRes.status).toBe(403);
  const readRes = await app.request("/api/theme-colors", { headers: { cookie } });
  expect(readRes.status).toBe(200);
});
