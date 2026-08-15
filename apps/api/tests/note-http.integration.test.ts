import { afterEach, describe, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { withCleanDb } from "./helpers/db.js";

// issue 437: "Poznámky" — ZDIEĽANÁ nástenka. Na rozdiel od `daily-tasks-http`
// (súkromný, per-používateľský zoznam s IDOR ochranou) tu druhý používateľ
// VIDÍ a smie vybaviť/zmazať cudziu poznámku — presne to tieto testy overujú.
const HESLO = "test-heslo-abc";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function bootUser(email: string, role: UserRole) {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({ email, passwordHash: await hashPassword(HESLO), displayName: email, role });
  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db };
}

// Druhý používateľ v TEJ ISTEJ (už čistej) DB — `withCleanDb()` TRUNCATE-uje
// `users` len raz na začiatku, druhé prihlásenie sa preto len PRIDÁ (rovnaký
// princíp ako `daily-tasks-http.integration.test.ts`'s `secondLogin`).
async function secondLogin(app: ReturnType<typeof createApp>, db: Awaited<ReturnType<typeof withCleanDb>>["db"], email: string, role: UserRole) {
  await db.insert(users).values({ email, passwordHash: await hashPassword(HESLO), displayName: email, role });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { cookie };
}

describe("GET /api/notes", () => {
  it("bez prihlásenia vráti 401", async () => {
    const { app } = await bootUser("sef@forestshop.sk", "sef");
    const res = await app.request("/api/notes");
    expect(res.status).toBe(401);
  });

  it("čerstvá DB má prázdny zoznam", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "sef");
    const res = await app.request("/api/notes", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: readonly unknown[] };
    expect(body.rows).toEqual([]);
  });

  it("zoznam je zoradený najnovšie hore a nesie meno autora", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "sef");
    await app.request("/api/notes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "objednať sáčky" }) });
    await app.request("/api/notes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "zavolať Záhoreckému" }) });

    const res = await app.request("/api/notes", { headers: { cookie } });
    const body = (await res.json()) as { rows: readonly { body: string; authorName: string; resolvedAt: string | null }[] };
    expect(body.rows.map((r) => r.body)).toEqual(["zavolať Záhoreckému", "objednať sáčky"]);
    expect(body.rows[0]?.authorName).toBe("sef@forestshop.sk");
    expect(body.rows[0]?.resolvedAt).toBeNull();
  });

  it("poznámky sú ZDIEĽANÉ — druhý používateľ VIDÍ cudziu poznámku vrátane mena autora", async () => {
    const { app, cookie, db } = await bootUser("sef@forestshop.sk", "sef");
    await app.request("/api/notes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "šéfova zdieľaná poznámka" }) });

    const other = await secondLogin(app, db, "zamestnanec@forestshop.sk", "manazer");
    const res = await app.request("/api/notes", { headers: { cookie: other.cookie } });
    const body = (await res.json()) as { rows: readonly { body: string; authorName: string }[] };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ body: "šéfova zdieľaná poznámka", authorName: "sef@forestshop.sk" });
  });
});

describe("POST /api/notes", () => {
  it("vytvorí poznámku (autor zo session, nie z tela)", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "sef");
    const res = await app.request("/api/notes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "nápad na akciu" }) });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { ok: boolean; id: string };
    expect(created.ok).toBe(true);

    const list = await app.request("/api/notes", { headers: { cookie } });
    const body = (await list.json()) as { rows: readonly { id: string; body: string; authorName: string; resolvedAt: string | null }[] };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ id: created.id, body: "nápad na akciu", authorName: "sef@forestshop.sk", resolvedAt: null });
  });

  it("prázdny text je odmietnutý (400)", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "sef");
    const res = await app.request("/api/notes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "  " }) });
    expect(res.status).toBe(400);
  });

  it("príliš dlhý text (>2000 znakov) je odmietnutý (400)", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "sef");
    const res = await app.request("/api/notes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "x".repeat(2001) }) });
    expect(res.status).toBe(400);
  });

  it("rola 'sef' (Štěpán) SMIE vytvoriť poznámku — žiadny role-gating na zdieľanej nástenke", async () => {
    const { app, cookie } = await bootUser("stepan@forestshop.sk", "sef");
    const res = await app.request("/api/notes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "Štěpánova poznámka z mobilu" }) });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/notes/:id/resolve", () => {
  it("označí ako vybavenú a späť ako nevybavenú (resolvedAt sa nastaví/zruší, riadok ostáva)", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "sef");
    const create = await app.request("/api/notes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "Poznámka" }) });
    const { id } = (await create.json()) as { id: string };

    const resolve = await app.request(`/api/notes/${id}/resolve`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ resolved: true }) });
    expect((await resolve.json()) as { ok: boolean; updated: boolean }).toEqual({ ok: true, updated: true });
    const afterResolve = await app.request("/api/notes", { headers: { cookie } });
    const listResolved = (await afterResolve.json()) as { rows: readonly { resolvedAt: string | null }[] };
    expect(listResolved.rows).toHaveLength(1); // vybavená poznámka OSTÁVA v zozname
    expect(listResolved.rows[0]?.resolvedAt).not.toBeNull();

    const unresolve = await app.request(`/api/notes/${id}/resolve`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ resolved: false }) });
    expect((await unresolve.json()) as { updated: boolean }).toEqual({ ok: true, updated: true });
    const afterUnresolve = await app.request("/api/notes", { headers: { cookie } });
    expect(((await afterUnresolve.json()) as { rows: readonly { resolvedAt: string | null }[] }).rows[0]?.resolvedAt).toBeNull();
  });

  it("ZDIEĽANÉ — INÝ používateľ smie vybaviť cudziu poznámku (updated:true)", async () => {
    const { app, cookie, db } = await bootUser("sef@forestshop.sk", "sef");
    const create = await app.request("/api/notes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "Šéfova poznámka" }) });
    const { id } = (await create.json()) as { id: string };

    const other = await secondLogin(app, db, "zamestnanec@forestshop.sk", "manazer");
    const resolve = await app.request(`/api/notes/${id}/resolve`, { method: "POST", headers: { cookie: other.cookie, "content-type": "application/json" }, body: JSON.stringify({ resolved: true }) });
    expect((await resolve.json()) as { ok: boolean; updated: boolean }).toEqual({ ok: true, updated: true });

    const list = await app.request("/api/notes", { headers: { cookie } });
    expect(((await list.json()) as { rows: readonly { resolvedAt: string | null }[] }).rows[0]?.resolvedAt).not.toBeNull();
  });

  it("neznáme id vráti 200 {updated:false}, nikdy chybu", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "sef");
    const res = await app.request("/api/notes/00000000-0000-0000-0000-000000000000/resolve", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ resolved: true }) });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; updated: boolean }).toEqual({ ok: true, updated: false });
  });
});

describe("DELETE /api/notes/:id", () => {
  it("okamžite odstráni poznámku", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "sef");
    const create = await app.request("/api/notes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "Na zmazanie" }) });
    const { id } = (await create.json()) as { id: string };

    const del = await app.request(`/api/notes/${id}`, { method: "DELETE", headers: { cookie } });
    expect((await del.json()) as { removed: boolean }).toEqual({ ok: true, removed: true });

    const list = await app.request("/api/notes", { headers: { cookie } });
    expect(((await list.json()) as { rows: readonly unknown[] }).rows).toEqual([]);
  });

  it("ZDIEĽANÉ — INÝ používateľ smie zmazať cudziu poznámku (removed:true)", async () => {
    const { app, cookie, db } = await bootUser("sef@forestshop.sk", "sef");
    const create = await app.request("/api/notes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "Šéfova poznámka" }) });
    const { id } = (await create.json()) as { id: string };

    const other = await secondLogin(app, db, "zamestnanec@forestshop.sk", "manazer");
    const del = await app.request(`/api/notes/${id}`, { method: "DELETE", headers: { cookie: other.cookie } });
    expect((await del.json()) as { removed: boolean }).toEqual({ ok: true, removed: true });

    const list = await app.request("/api/notes", { headers: { cookie } });
    expect(((await list.json()) as { rows: readonly unknown[] }).rows).toEqual([]);
  });

  it("neznáme id vráti 200 {removed:false}, nikdy chybu", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "sef");
    const res = await app.request("/api/notes/00000000-0000-0000-0000-000000000000", { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; removed: boolean }).toEqual({ ok: true, removed: false });
  });
});
