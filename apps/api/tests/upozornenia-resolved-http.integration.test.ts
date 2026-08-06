import { afterEach, describe, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { autoResolveByDedupKey, upsertUpozornenie } from "../src/modules/upozornenia/service.js";
import { withCleanDb } from "./helpers/db.js";

// issue 283 (majiteľ, komentár na tickete): "Vybavené" záložka — HTTP vrstva
// pre `GET /api/upozornenia/resolved` a `POST /api/upozornenia/:id/return-to-
// open`, vydelené do VLASTNÉHO súboru rovnakým vzorom ako `upozornenia-http
// .integration.test.ts` (`.claude/rules/testing.md`'s eslint `max-lines: 400`).
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
  await ctx.db.insert(users).values({ email: "pouzivatel-283@forestshop.sk", passwordHash: await hashPassword(HESLO), displayName: "Test", role });
  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "pouzivatel-283@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db };
}

describe("GET /api/upozornenia/resolved", () => {
  // Rola 'citanie' nesmie `POST /resolve` (`requireRole("admin","manazer")`)
  // — táto rola tu preto len ČÍTA, vyriešenie nastáva PRIAMO cez `db`
  // (`autoResolveByDedupKey`, rovnaký vzor ako `upozornenia-http.integration
  // .test.ts`'s `upsertUpozornenie(db, ...)` volania), nie cez HTTP trasu,
  // ktorú by táto rola dostala 403.
  it("čítanie funguje pre KAŽDÚ prihlásenú rolu (aj len-na-čítanie), vráti len vyriešené", async () => {
    const { app, cookie, db } = await boot("citanie");
    const now = new Date("2026-08-06T08:00:00Z");
    await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Otvorená", now });
    await upsertUpozornenie(db, { type: "nevyzdvihnuta_zasielka", source: "appka", title: "Vyriešená", dedupKey: "posta:283TEST", now });
    await autoResolveByDedupKey(db, "posta:283TEST", now);

    const res = await app.request("/api/upozornenia/resolved", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: readonly { title: string }[] };
    expect(body.rows.map((r) => r.title)).toEqual(["Vyriešená"]);
  });

  it("nesie meno toho, kto vyriešil (rola 'manazer' klikla 'Vybavené' cez HTTP)", async () => {
    const { app, cookie, db } = await boot("manazer");
    const now = new Date("2026-08-06T08:00:00Z");
    const resolvedCreate = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Vyriešená", now });
    await app.request(`/api/upozornenia/${resolvedCreate.id}/resolve`, { method: "POST", headers: { cookie } });

    const res = await app.request("/api/upozornenia/resolved", { headers: { cookie } });
    const body = (await res.json()) as { rows: readonly { title: string; resolvedByName: string | null }[] };
    expect(body.rows.map((r) => r.title)).toEqual(["Vyriešená"]);
    expect(body.rows[0]?.resolvedByName).toBe("Test");
  });

  it("bez prihlásenia vráti 401", async () => {
    const { app } = await boot("manazer");
    const res = await app.request("/api/upozornenia/resolved");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/upozornenia/:id/return-to-open", () => {
  it("rola 'citanie' NEMÔŽE vrátiť kartu späť (403)", async () => {
    const { app, cookie, db } = await boot("citanie");
    const now = new Date("2026-08-06T08:00:00Z");
    const created = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Vyriešená", now });
    await app.request(`/api/upozornenia/${created.id}/resolve`, { method: "POST", headers: { cookie } });
    const res = await app.request(`/api/upozornenia/${created.id}/return-to-open`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(403);
  });

  it("rola 'manazer' vráti vyriešenú kartu späť medzi otvorené — objaví sa v predvolenom (bez includeResolved) zozname", async () => {
    const { app, cookie, db } = await boot("manazer");
    const now = new Date("2026-08-06T08:00:00Z");
    const created = await upsertUpozornenie(db, { type: "vlastna_poznamka", source: "vlastne", title: "Omylom vybavená", now });
    await app.request(`/api/upozornenia/${created.id}/resolve`, { method: "POST", headers: { cookie } });

    const returnRes = await app.request(`/api/upozornenia/${created.id}/return-to-open`, { method: "POST", headers: { cookie } });
    expect((await returnRes.json()) as { ok: boolean; result: string }).toEqual({ ok: true, result: "returned" });

    const list = await app.request("/api/upozornenia", { headers: { cookie } });
    const body = (await list.json()) as { rows: readonly { title: string; status: string }[] };
    expect(body.rows.map((r) => r.title)).toEqual(["Omylom vybavená"]);
    expect(body.rows[0]?.status).toBe("otvorene");

    const resolvedList = await app.request("/api/upozornenia/resolved", { headers: { cookie } });
    const resolvedBody = (await resolvedList.json()) as { rows: readonly unknown[] };
    expect(resolvedBody.rows).toEqual([]);
  });

  it("neznáme id vráti 200 {result:'no_op'}, nikdy chybu", async () => {
    const { app, cookie } = await boot("manazer");
    const res = await app.request("/api/upozornenia/00000000-0000-0000-0000-000000000000/return-to-open", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; result: string }).toEqual({ ok: true, result: "no_op" });
  });

  it("kolízia s existujúcou otvorenou kartou rovnakého dedupKey vráti 200 {result:'collision'}, nikdy 500", async () => {
    const { app, cookie, db } = await boot("manazer");
    const now = new Date("2026-08-06T08:00:00Z");
    const dedupKey = "vratenie:20700099";
    const resolved = await upsertUpozornenie(db, { type: "vratenie", source: "appka", title: "Staršia vlna", dedupKey, now });
    await app.request(`/api/upozornenia/${resolved.id}/resolve`, { method: "POST", headers: { cookie } });
    await upsertUpozornenie(db, { type: "vratenie", source: "appka", title: "Nová vlna", dedupKey, now: new Date("2026-08-06T12:00:00Z") });

    const res = await app.request(`/api/upozornenia/${resolved.id}/return-to-open`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; result: string }).toEqual({ ok: true, result: "collision" });
  });

  it("bez prihlásenia vráti 401", async () => {
    const { app } = await boot("manazer");
    const res = await app.request("/api/upozornenia/00000000-0000-0000-0000-000000000000/return-to-open", { method: "POST" });
    expect(res.status).toBe(401);
  });
});
