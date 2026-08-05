import { afterEach, describe, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { upsertUpozornenie } from "../src/modules/upozornenia/service.js";
import { withCleanDb } from "./helpers/db.js";

// issue 267: HTTP vrstva pre "Eshop → Upozornenia".
const HESLO = "test-heslo-abc";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot(role: UserRole) {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({ email: "pouzivatel@forestshop.sk", passwordHash: await hashPassword(HESLO), displayName: "Test", role });
  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "pouzivatel@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db };
}

describe("GET /api/upozornenia", () => {
  it("čítanie funguje pre KAŽDÚ prihlásenú rolu (aj len-na-čítanie)", async () => {
    const { app, cookie } = await boot("citanie");
    const res = await app.request("/api/upozornenia", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: readonly unknown[] };
    expect(body.rows).toEqual([]);
  });

  it("bez prihlásenia vráti 401", async () => {
    const { app } = await boot("manazer");
    const res = await app.request("/api/upozornenia");
    expect(res.status).toBe(401);
  });

  it("predvolený filter vynechá vyriešené a odložené karty, 'aj vybavené' ich vráti", async () => {
    const { app, cookie, db } = await boot("manazer");
    const now = new Date("2026-08-05T08:00:00Z");
    await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Aktívna", now });
    const resolvedCreate = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Vyriešená", now });
    await app.request(`/api/upozornenia/${resolvedCreate.id}/resolve`, { method: "POST", headers: { cookie } });

    const defaultRes = await app.request("/api/upozornenia", { headers: { cookie } });
    const defaultBody = (await defaultRes.json()) as { rows: readonly { title: string }[] };
    expect(defaultBody.rows.map((r) => r.title)).toEqual(["Aktívna"]);

    const allRes = await app.request("/api/upozornenia?includeResolved=true", { headers: { cookie } });
    const allBody = (await allRes.json()) as { rows: readonly { title: string }[] };
    expect(allBody.rows.map((r) => r.title).sort()).toEqual(["Aktívna", "Vyriešená"]);
  });
});

describe("GET /api/upozornenia/count", () => {
  it("počíta len akčné (nevybavené a neodložené) karty", async () => {
    const { app, cookie, db } = await boot("manazer");
    const now = new Date("2026-08-05T08:00:00Z");
    await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Aktívna", now });
    const postponedCreate = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Odložená", now });
    await app.request(`/api/upozornenia/${postponedCreate.id}/postpone`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ until: "2099-01-01T00:00:00.000Z" }),
    });

    const res = await app.request("/api/upozornenia/count", { headers: { cookie } });
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(1);
  });
});

describe("POST /api/upozornenia (vlastná poznámka)", () => {
  it("rola 'citanie' NEMÔŽE vytvoriť poznámku (403)", async () => {
    const { app, cookie } = await boot("citanie");
    const res = await app.request("/api/upozornenia", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Pokus" }),
    });
    expect(res.status).toBe(403);
  });

  it("rola 'manazer' vytvorí poznámku a vidí ju v zozname", async () => {
    const { app, cookie } = await boot("manazer");
    const create = await app.request("/api/upozornenia", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Schôdzka v stredu", details: "o 10:00" }),
    });
    expect(create.status).toBe(200);
    const created = (await create.json()) as { ok: boolean; id: string };
    expect(created.ok).toBe(true);

    const list = await app.request("/api/upozornenia", { headers: { cookie } });
    const body = (await list.json()) as { rows: readonly { id: string; title: string; details: string; status: string }[] };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.id).toBe(created.id);
    expect(body.rows[0]?.details).toBe("o 10:00");
    // Ešte nebola videná (žiadne otvorenie záložky/`mark-seen`).
    expect(body.rows[0]?.status).toBe("nove");
  });

  it("prázdny nadpis je odmietnutý (400)", async () => {
    const { app, cookie } = await boot("manazer");
    const res = await app.request("/api/upozornenia", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/upozornenia/mark-seen", () => {
  it("po zavolaní sa nevidená karta stane 'otvorene'", async () => {
    const { app, cookie, db } = await boot("manazer");
    const now = new Date("2026-08-05T08:00:00Z");
    await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Nová", now });

    const seenRes = await app.request("/api/upozornenia/mark-seen", { method: "POST", headers: { cookie } });
    const seenBody = (await seenRes.json()) as { ok: boolean; marked: number };
    expect(seenBody.marked).toBe(1);

    const list = await app.request("/api/upozornenia", { headers: { cookie } });
    const body = (await list.json()) as { rows: readonly { status: string }[] };
    expect(body.rows[0]?.status).toBe("otvorene");
  });
});

describe("PATCH/DELETE /api/upozornenia/:id", () => {
  it("upraví vlastnú poznámku", async () => {
    const { app, cookie } = await boot("manazer");
    const create = await app.request("/api/upozornenia", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Pôvodná" }),
    });
    const { id } = (await create.json()) as { id: string };
    const patch = await app.request(`/api/upozornenia/${id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Upravená" }),
    });
    expect((await patch.json()) as { ok: boolean; updated: boolean }).toEqual({ ok: true, updated: true });

    const list = await app.request("/api/upozornenia", { headers: { cookie } });
    const body = (await list.json()) as { rows: readonly { title: string }[] };
    expect(body.rows[0]?.title).toBe("Upravená");
  });

  it("zmazanie neznámeho id vráti 200 {removed:false}, nikdy chybu", async () => {
    const { app, cookie } = await boot("manazer");
    const res = await app.request("/api/upozornenia/00000000-0000-0000-0000-000000000000", { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; removed: boolean }).toEqual({ ok: true, removed: false });
  });
});
