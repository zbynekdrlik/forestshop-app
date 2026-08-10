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

  // Živé overenie po nasadení (issue 267 follow-up, gap 2): odložená karta
  // bola neviditeľná ÚPLNE VŽDY, aj s `includeResolved=true` — nová nezávislá
  // os `includePostponed` ju odkryje bez toho, aby menila význam
  // "aj vybavené".
  it("predvolený filter vynechá odloženú kartu, 'aj odložené' ju vráti", async () => {
    const { app, cookie, db } = await boot("manazer");
    const now = new Date("2026-08-05T08:00:00Z");
    await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Aktívna", now });
    const postponedCreate = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Odložená", now });
    await app.request(`/api/upozornenia/${postponedCreate.id}/postpone`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ until: "2099-01-01T00:00:00.000Z" }),
    });

    const defaultRes = await app.request("/api/upozornenia", { headers: { cookie } });
    const defaultBody = (await defaultRes.json()) as { rows: readonly { title: string }[] };
    expect(defaultBody.rows.map((r) => r.title)).toEqual(["Aktívna"]);

    const postponedRes = await app.request("/api/upozornenia?includePostponed=true", { headers: { cookie } });
    const postponedBody = (await postponedRes.json()) as { rows: readonly { title: string }[] };
    expect(postponedBody.rows.map((r) => r.title).sort()).toEqual(["Aktívna", "Odložená"]);
  });
});

describe("POST /api/upozornenia/:id/cancel-postpone", () => {
  it("zruší odloženie a karta sa vráti aj do PREDVOLENÉHO (bez includePostponed) zoznamu", async () => {
    const { app, cookie, db } = await boot("manazer");
    const now = new Date("2026-08-05T08:00:00Z");
    const created = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Odložená omylom", now });
    await app.request(`/api/upozornenia/${created.id}/postpone`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ until: "2099-01-01T00:00:00.000Z" }),
    });

    const cancelRes = await app.request(`/api/upozornenia/${created.id}/cancel-postpone`, { method: "POST", headers: { cookie } });
    expect((await cancelRes.json()) as { ok: boolean; cancelled: boolean }).toEqual({ ok: true, cancelled: true });

    const list = await app.request("/api/upozornenia", { headers: { cookie } });
    const body = (await list.json()) as { rows: readonly { title: string; status: string }[] };
    expect(body.rows.map((r) => r.title)).toEqual(["Odložená omylom"]);
    expect(body.rows[0]?.status).toBe("otvorene");
  });

  it("neznáme id vráti 200 {cancelled:false}, nikdy chybu", async () => {
    const { app, cookie } = await boot("manazer");
    const res = await app.request("/api/upozornenia/00000000-0000-0000-0000-000000000000/cancel-postpone", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; cancelled: boolean }).toEqual({ ok: true, cancelled: false });
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

  // Code review: len postponed-vylúčenie bolo overené vyššie — pridané aj
  // pre resolved (rovnaká zdieľaná SQL podmienka `notPostponedCondition` +
  // `isNull(resolvedAt)` v `queries.ts`, obe strany testu patria k sebe).
  it("vyriešená karta sa do počtu nezapočítava", async () => {
    const { app, cookie, db } = await boot("manazer");
    const now = new Date("2026-08-05T08:00:00Z");
    await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Aktívna", now });
    const resolvedCreate = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Vyriešená", now });
    await app.request(`/api/upozornenia/${resolvedCreate.id}/resolve`, { method: "POST", headers: { cookie } });

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

  // issue 327: mazanie UŽ NIE JE obmedzené na vlastné poznámky (issue 267) —
  // aj karta zo zdroja "appka" (automatický zdroj) sa dá cez túto trasu
  // odstrániť.
  it("issue 327: zmaže AJ kartu zo zdroja 'appka' (automatický zdroj)", async () => {
    const { app, cookie, db } = await boot("manazer");
    const now = new Date("2026-08-10T08:00:00Z");
    const created = await upsertUpozornenie(db, { type: "objednavka_visi", source: "appka", title: "Objednávka 1 visí", dedupKey: "objednavka-visi:1", now });

    const res = await app.request(`/api/upozornenia/${created.id}`, { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; removed: boolean }).toEqual({ ok: true, removed: true });

    const list = await app.request("/api/upozornenia", { headers: { cookie } });
    const body = (await list.json()) as { rows: readonly { id: string }[] };
    expect(body.rows.some((r) => r.id === created.id)).toBe(false);
  });

  // Code review pred mergom (issue 327): server-side vynútenie cez CELÚ
  // HTTP trasu, nielen v `service.ts` — vyriešenú kartu tento endpoint
  // NIKDY nezmaže (`.claude/rules/upozornenia.md`'s `vratenie` KONEČNOSŤ).
  it("issue 327: NEZMAŽE vyriešenú kartu (removed:false, karta ostáva v zozname 'Vybavené')", async () => {
    const { app, cookie, db } = await boot("manazer");
    const now = new Date("2026-08-10T08:00:00Z");
    const created = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Vybavené", now });
    const resolveRes = await app.request(`/api/upozornenia/${created.id}/resolve`, { method: "POST", headers: { cookie } });
    expect(((await resolveRes.json()) as { resolved: boolean }).resolved).toBe(true);

    const res = await app.request(`/api/upozornenia/${created.id}`, { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; removed: boolean }).toEqual({ ok: true, removed: false });

    const resolvedList = await app.request("/api/upozornenia/resolved", { headers: { cookie } });
    const resolvedBody = (await resolvedList.json()) as { rows: readonly { id: string }[] };
    expect(resolvedBody.rows.some((r) => r.id === created.id)).toBe(true);
  });
});
