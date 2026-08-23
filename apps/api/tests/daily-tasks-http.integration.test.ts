import { afterEach, describe, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { withCleanDb } from "./helpers/db.js";

// issue 342: "Dôležité → Úlohy na dnes" — súkromný, per-používateľský zoznam.
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
// `users` len raz na začiatku testu, druhé prihlásenie sa preto len PRIDÁ do
// existujúceho pripojenia (rovnaký princíp ako `.claude/rules/testing.md`'s
// "DVA `boot()`-štýl helpery sa navzájom prepíšu" — tu sa preto NEVOLÁ
// `withCleanDb()` druhýkrát, len ďalší insert + login na tej istej `app`).
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

async function createTask(app: ReturnType<typeof createApp>, cookie: string, text: string): Promise<string> {
  const res = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text }) });
  return ((await res.json()) as { id: string }).id;
}

async function readCount(app: ReturnType<typeof createApp>, cookie: string): Promise<number> {
  const res = await app.request("/api/daily-tasks/count", { headers: { cookie } });
  return ((await res.json()) as { count: number }).count;
}

async function setDone(app: ReturnType<typeof createApp>, cookie: string, id: string, done: boolean): Promise<void> {
  await app.request(`/api/daily-tasks/${id}/done`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ done }) });
}

describe("GET /api/daily-tasks", () => {
  it("bez prihlásenia vráti 401", async () => {
    const { app } = await bootUser("sef@forestshop.sk", "admin");
    const res = await app.request("/api/daily-tasks");
    expect(res.status).toBe(401);
  });

  it("čerstvý používateľ má prázdny zoznam", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const res = await app.request("/api/daily-tasks", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: readonly unknown[] };
    expect(body.rows).toEqual([]);
  });

  it("zoznam je zoradený najnovšie hore", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "poslať DPD" }) });
    await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Nemáme sáčky" }) });

    const res = await app.request("/api/daily-tasks", { headers: { cookie } });
    const body = (await res.json()) as { rows: readonly { text: string }[] };
    expect(body.rows.map((r) => r.text)).toEqual(["Nemáme sáčky", "poslať DPD"]);
  });

  it("úlohy sú OSOBNÉ — druhý používateľ ich v zozname nevidí", async () => {
    const { app, cookie, db } = await bootUser("sef@forestshop.sk", "admin");
    await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "šéfova súkromná úloha" }) });

    const other = await secondLogin(app, db, "zamestnanec@forestshop.sk", "manazer");
    const res = await app.request("/api/daily-tasks", { headers: { cookie: other.cookie } });
    const body = (await res.json()) as { rows: readonly unknown[] };
    expect(body.rows).toEqual([]);
  });
});

describe("POST /api/daily-tasks", () => {
  it("vytvorí úlohu len s textom, žiadne ďalšie pole nie je povinné", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const res = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Záhorecký volať" }) });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { ok: boolean; id: string };
    expect(created.ok).toBe(true);

    const list = await app.request("/api/daily-tasks", { headers: { cookie } });
    const body = (await list.json()) as { rows: readonly { id: string; text: string; emoji: string | null; doneAt: string | null }[] };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ id: created.id, text: "Záhorecký volať", emoji: null, doneAt: null });
  });

  it("prázdny text je odmietnutý (400)", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const res = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "  " }) });
    expect(res.status).toBe(400);
  });

  it("rola 'citanie' SMIE vytvoriť vlastnú úlohu — je to jej vlastný súkromný zoznam", async () => {
    const { app, cookie } = await bootUser("zamestnanec@forestshop.sk", "citanie");
    const res = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "moja poznámka" }) });
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/daily-tasks/:id/text", () => {
  it("upraví text vlastnej úlohy", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const create = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Pôvodná" }) });
    const { id } = (await create.json()) as { id: string };

    const patch = await app.request(`/api/daily-tasks/${id}/text`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Upravená" }) });
    expect((await patch.json()) as { ok: boolean; updated: boolean }).toEqual({ ok: true, updated: true });

    const list = await app.request("/api/daily-tasks", { headers: { cookie } });
    const body = (await list.json()) as { rows: readonly { text: string }[] };
    expect(body.rows[0]?.text).toBe("Upravená");
  });

  it("CUDZIU úlohu neupraví (updated:false), text ostane pôvodný", async () => {
    const { app, cookie, db } = await bootUser("sef@forestshop.sk", "admin");
    const create = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Šéfova úloha" }) });
    const { id } = (await create.json()) as { id: string };

    const other = await secondLogin(app, db, "zamestnanec@forestshop.sk", "manazer");
    const patch = await app.request(`/api/daily-tasks/${id}/text`, { method: "PATCH", headers: { cookie: other.cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Prepísané cudzím" }) });
    expect((await patch.json()) as { ok: boolean; updated: boolean }).toEqual({ ok: true, updated: false });

    const list = await app.request("/api/daily-tasks", { headers: { cookie } });
    const body = (await list.json()) as { rows: readonly { text: string }[] };
    expect(body.rows[0]?.text).toBe("Šéfova úloha");
  });
});

describe("PATCH /api/daily-tasks/:id/emoji", () => {
  it("pridá a potom zmaže emoji (null)", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const create = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Úloha" }) });
    const { id } = (await create.json()) as { id: string };

    const setEmoji = await app.request(`/api/daily-tasks/${id}/emoji`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ emoji: "🚚" }) });
    expect((await setEmoji.json()) as { updated: boolean }).toEqual({ ok: true, updated: true });
    const afterSet = await app.request("/api/daily-tasks", { headers: { cookie } });
    expect(((await afterSet.json()) as { rows: readonly { emoji: string | null }[] }).rows[0]?.emoji).toBe("🚚");

    const clearEmoji = await app.request(`/api/daily-tasks/${id}/emoji`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ emoji: null }) });
    expect((await clearEmoji.json()) as { updated: boolean }).toEqual({ ok: true, updated: true });
    const afterClear = await app.request("/api/daily-tasks", { headers: { cookie } });
    expect(((await afterClear.json()) as { rows: readonly { emoji: string | null }[] }).rows[0]?.emoji).toBeNull();
  });

  // Code review: symetrické pokrytie s "PATCH .../text"'s a "DELETE"'s
  // rovnaké IDOR testy nižšie — implementácia je identická (`and(eq(id),
  // eq(userId))`), ale bez PRIAMEHO testu by táto cesta ostala pokrytá len
  // nepriamo.
  it("CUDZIU úlohu neupraví emoji (updated:false), emoji ostane pôvodné", async () => {
    const { app, cookie, db } = await bootUser("sef@forestshop.sk", "admin");
    const create = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Šéfova úloha" }) });
    const { id } = (await create.json()) as { id: string };

    const other = await secondLogin(app, db, "zamestnanec@forestshop.sk", "manazer");
    const patch = await app.request(`/api/daily-tasks/${id}/emoji`, { method: "PATCH", headers: { cookie: other.cookie, "content-type": "application/json" }, body: JSON.stringify({ emoji: "🚚" }) });
    expect((await patch.json()) as { ok: boolean; updated: boolean }).toEqual({ ok: true, updated: false });

    const list = await app.request("/api/daily-tasks", { headers: { cookie } });
    const body = (await list.json()) as { rows: readonly { emoji: string | null }[] };
    expect(body.rows[0]?.emoji).toBeNull();
  });
});

describe("POST /api/daily-tasks/:id/done", () => {
  it("označí ako vybavené a späť ako nevybavené (doneAt sa nastaví/zruší)", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const create = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Úloha" }) });
    const { id } = (await create.json()) as { id: string };

    const markDone = await app.request(`/api/daily-tasks/${id}/done`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
    expect((await markDone.json()) as { updated: boolean }).toEqual({ ok: true, updated: true });
    const afterDone = await app.request("/api/daily-tasks", { headers: { cookie } });
    expect(((await afterDone.json()) as { rows: readonly { doneAt: string | null }[] }).rows[0]?.doneAt).not.toBeNull();

    const markUndone = await app.request(`/api/daily-tasks/${id}/done`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ done: false }) });
    expect((await markUndone.json()) as { updated: boolean }).toEqual({ ok: true, updated: true });
    const afterUndone = await app.request("/api/daily-tasks", { headers: { cookie } });
    expect(((await afterUndone.json()) as { rows: readonly { doneAt: string | null }[] }).rows[0]?.doneAt).toBeNull();
  });

  // Code review: rovnaké symetrické IDOR pokrytie ako "PATCH .../emoji" vyššie.
  it("CUDZIU úlohu neoznačí ako vybavenú (updated:false), doneAt ostane null", async () => {
    const { app, cookie, db } = await bootUser("sef@forestshop.sk", "admin");
    const create = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Šéfova úloha" }) });
    const { id } = (await create.json()) as { id: string };

    const other = await secondLogin(app, db, "zamestnanec@forestshop.sk", "manazer");
    const markDone = await app.request(`/api/daily-tasks/${id}/done`, { method: "POST", headers: { cookie: other.cookie, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
    expect((await markDone.json()) as { ok: boolean; updated: boolean }).toEqual({ ok: true, updated: false });

    const list = await app.request("/api/daily-tasks", { headers: { cookie } });
    const body = (await list.json()) as { rows: readonly { doneAt: string | null }[] };
    expect(body.rows[0]?.doneAt).toBeNull();
  });
});

describe("DELETE /api/daily-tasks/:id", () => {
  it("okamžite odstráni vlastnú úlohu", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const create = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Na zmazanie" }) });
    const { id } = (await create.json()) as { id: string };

    const del = await app.request(`/api/daily-tasks/${id}`, { method: "DELETE", headers: { cookie } });
    expect((await del.json()) as { removed: boolean }).toEqual({ ok: true, removed: true });

    const list = await app.request("/api/daily-tasks", { headers: { cookie } });
    expect(((await list.json()) as { rows: readonly unknown[] }).rows).toEqual([]);
  });

  it("neznáme id vráti 200 {removed:false}, nikdy chybu", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const res = await app.request("/api/daily-tasks/00000000-0000-0000-0000-000000000000", { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; removed: boolean }).toEqual({ ok: true, removed: false });
  });

  it("CUDZIU úlohu nezmaže (removed:false), ostáva v zozname vlastníka", async () => {
    const { app, cookie, db } = await bootUser("sef@forestshop.sk", "admin");
    const create = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Šéfova úloha" }) });
    const { id } = (await create.json()) as { id: string };

    const other = await secondLogin(app, db, "zamestnanec@forestshop.sk", "manazer");
    const del = await app.request(`/api/daily-tasks/${id}`, { method: "DELETE", headers: { cookie: other.cookie } });
    expect((await del.json()) as { removed: boolean }).toEqual({ ok: true, removed: false });

    const list = await app.request("/api/daily-tasks", { headers: { cookie } });
    expect(((await list.json()) as { rows: readonly { id: string }[] }).rows.map((r) => r.id)).toEqual([id]);
  });
});

// issue 473: odznak počtu v ľavom menu — počet MOJICH otvorených (bez fajky) úloh.
describe("GET /api/daily-tasks/count", () => {
  it("bez prihlásenia vráti 401", async () => {
    const { app } = await bootUser("sef@forestshop.sk", "admin");
    const res = await app.request("/api/daily-tasks/count");
    expect(res.status).toBe(401);
  });

  it("čerstvý používateľ má count 0", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const res = await app.request("/api/daily-tasks/count", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { count: number }).toEqual({ count: 0 });
  });

  it("počíta LEN otvorené úlohy — vybavená (s fajkou) sa neráta", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const a = await createTask(app, cookie, "A");
    await createTask(app, cookie, "B");
    await createTask(app, cookie, "C");
    await setDone(app, cookie, a, true);

    expect(await readCount(app, cookie)).toBe(2);
  });

  it("odfajknutie a späť mení count OBOMA smermi (POST /:id/done nastaví done explicitne v oboch smeroch)", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const id = await createTask(app, cookie, "úloha");
    expect(await readCount(app, cookie)).toBe(1);

    await setDone(app, cookie, id, true);
    expect(await readCount(app, cookie)).toBe(0);

    await setDone(app, cookie, id, false);
    expect(await readCount(app, cookie)).toBe(1);
  });

  it("count je PER-POUŽÍVATEĽ — cudzie otvorené úlohy sa nerátajú", async () => {
    const { app, cookie, db } = await bootUser("sef@forestshop.sk", "admin");
    await createTask(app, cookie, "šéfova 1");
    await createTask(app, cookie, "šéfova 2");

    const other = await secondLogin(app, db, "zamestnanec@forestshop.sk", "manazer");
    // druhý používateľ vidí LEN svoje (0), nie šéfove dve
    expect(await readCount(app, other.cookie)).toBe(0);
    // vlastník vidí svoje dve
    expect(await readCount(app, cookie)).toBe(2);
  });
});
