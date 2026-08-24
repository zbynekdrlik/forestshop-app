import { afterEach, describe, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { withCleanDb } from "./helpers/db.js";

// issue 342 + 487: "Dôležité → Úlohy na dnes". PÔVODNE súkromný per-používateľský
// zoznam (#342); od #487 ZDIEĽANÝ — každý prihlásený účet vidí a smie odfajknúť/
// upraviť/zmazať VŠETKY úlohy (presne ako `note`/Poznámky, #437), autor sa
// zobrazuje pri riadku. Tieto testy boli PREPÍSANÉ z pôvodnej per-user (IDOR)
// sémantiky na zdieľanú: kde predtým „cudzí účet nič nezmení / nevidí", teraz
// „iný účet vidí a smie meniť" — server vlastníctvo pri čítaní/zápise už
// nevynucuje (`modules/daily-tasks/service.ts`/`queries.ts`).
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

async function listRows(app: ReturnType<typeof createApp>, cookie: string) {
  const res = await app.request("/api/daily-tasks", { headers: { cookie } });
  return ((await res.json()) as { rows: readonly { id: string; text: string; emoji: string | null; authorUserId: string; authorName: string; doneAt: string | null }[] }).rows;
}

describe("GET /api/daily-tasks", () => {
  it("bez prihlásenia vráti 401", async () => {
    const { app } = await bootUser("sef@forestshop.sk", "admin");
    const res = await app.request("/api/daily-tasks");
    expect(res.status).toBe(401);
  });

  it("prázdna DB → prázdny zoznam", async () => {
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

    const rows = await listRows(app, cookie);
    expect(rows.map((r) => r.text)).toEqual(["Nemáme sáčky", "poslať DPD"]);
  });

  // issue 487: prepísané z pôvodného "úlohy sú OSOBNÉ — druhý používateľ ich
  // nevidí". Teraz ZDIEĽANÉ: iný účet vidí úlohu prvého účtu a riadok nesie
  // autora (JOIN na `users` — `authorUserId` + `authorName`).
  it("ZDIEĽANÉ — iný účet vidí úlohu prvého účtu; riadok nesie autora", async () => {
    const { app, cookie, db } = await bootUser("sef@forestshop.sk", "admin");
    await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "šéfova úloha" }) });

    const other = await secondLogin(app, db, "zamestnanec@forestshop.sk", "manazer");
    const rows = await listRows(app, other.cookie);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("šéfova úloha");
    // Autor = pôvodný účet (`displayName` = email v `bootUser`), NIE prihlásený B.
    expect(rows[0]?.authorName).toBe("sef@forestshop.sk");
    expect(typeof rows[0]?.authorUserId).toBe("string");
    expect(rows[0]?.authorUserId).not.toBe("");
  });
});

describe("POST /api/daily-tasks", () => {
  it("vytvorí úlohu len s textom, autor sa uloží zo session", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const res = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Záhorecký volať" }) });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { ok: boolean; id: string };
    expect(created.ok).toBe(true);

    const rows = await listRows(app, cookie);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: created.id, text: "Záhorecký volať", emoji: null, doneAt: null, authorName: "sef@forestshop.sk" });
  });

  it("prázdny text je odmietnutý (400)", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const res = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "  " }) });
    expect(res.status).toBe(400);
  });

  it("rola 'citanie' SMIE vytvoriť úlohu — zdieľaný tímový nástroj bez role-obmedzenia", async () => {
    const { app, cookie } = await bootUser("zamestnanec@forestshop.sk", "citanie");
    const res = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "moja poznámka" }) });
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/daily-tasks/:id/text", () => {
  it("upraví text úlohy", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const create = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Pôvodná" }) });
    const { id } = (await create.json()) as { id: string };

    const patch = await app.request(`/api/daily-tasks/${id}/text`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Upravená" }) });
    expect((await patch.json()) as { ok: boolean; updated: boolean }).toEqual({ ok: true, updated: true });

    const rows = await listRows(app, cookie);
    expect(rows[0]?.text).toBe("Upravená");
  });

  // issue 487: prepísané z IDOR testu — zdieľaný zoznam, iný účet MÔŽE upraviť.
  it("ZDIEĽANÉ — iný účet MÔŽE upraviť text úlohy prvého účtu (updated:true)", async () => {
    const { app, cookie, db } = await bootUser("sef@forestshop.sk", "admin");
    const create = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Šéfova úloha" }) });
    const { id } = (await create.json()) as { id: string };

    const other = await secondLogin(app, db, "zamestnanec@forestshop.sk", "manazer");
    const patch = await app.request(`/api/daily-tasks/${id}/text`, { method: "PATCH", headers: { cookie: other.cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Upravené kolegom" }) });
    expect((await patch.json()) as { ok: boolean; updated: boolean }).toEqual({ ok: true, updated: true });

    const rows = await listRows(app, cookie);
    expect(rows[0]?.text).toBe("Upravené kolegom");
  });
});

describe("PATCH /api/daily-tasks/:id/emoji", () => {
  it("pridá a potom zmaže emoji (null)", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const create = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Úloha" }) });
    const { id } = (await create.json()) as { id: string };

    const setEmoji = await app.request(`/api/daily-tasks/${id}/emoji`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ emoji: "🚚" }) });
    expect((await setEmoji.json()) as { updated: boolean }).toEqual({ ok: true, updated: true });
    expect((await listRows(app, cookie))[0]?.emoji).toBe("🚚");

    const clearEmoji = await app.request(`/api/daily-tasks/${id}/emoji`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ emoji: null }) });
    expect((await clearEmoji.json()) as { updated: boolean }).toEqual({ ok: true, updated: true });
    expect((await listRows(app, cookie))[0]?.emoji).toBeNull();
  });

  // issue 487: prepísané z IDOR testu — zdieľaný zoznam, iný účet MÔŽE upraviť emoji.
  it("ZDIEĽANÉ — iný účet MÔŽE upraviť emoji úlohy prvého účtu (updated:true)", async () => {
    const { app, cookie, db } = await bootUser("sef@forestshop.sk", "admin");
    const create = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Šéfova úloha" }) });
    const { id } = (await create.json()) as { id: string };

    const other = await secondLogin(app, db, "zamestnanec@forestshop.sk", "manazer");
    const patch = await app.request(`/api/daily-tasks/${id}/emoji`, { method: "PATCH", headers: { cookie: other.cookie, "content-type": "application/json" }, body: JSON.stringify({ emoji: "🚚" }) });
    expect((await patch.json()) as { ok: boolean; updated: boolean }).toEqual({ ok: true, updated: true });

    expect((await listRows(app, cookie))[0]?.emoji).toBe("🚚");
  });
});

describe("POST /api/daily-tasks/:id/done", () => {
  it("označí ako vybavené a späť ako nevybavené (doneAt sa nastaví/zruší)", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const create = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Úloha" }) });
    const { id } = (await create.json()) as { id: string };

    const markDone = await app.request(`/api/daily-tasks/${id}/done`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
    expect((await markDone.json()) as { updated: boolean }).toEqual({ ok: true, updated: true });
    expect((await listRows(app, cookie))[0]?.doneAt).not.toBeNull();

    const markUndone = await app.request(`/api/daily-tasks/${id}/done`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ done: false }) });
    expect((await markUndone.json()) as { updated: boolean }).toEqual({ ok: true, updated: true });
    expect((await listRows(app, cookie))[0]?.doneAt).toBeNull();
  });

  // issue 487 — HLAVNÝ akceptačný test: účet B vidí a ODFAJKNE úlohu účtu A.
  it("účet B vidí a odfajkne úlohu účtu A (zdieľané), zmena je viditeľná aj účtu A", async () => {
    const { app, cookie, db } = await bootUser("sef@forestshop.sk", "admin");
    const id = await createTask(app, cookie, "šéfova úloha na odfajknutie");

    const other = await secondLogin(app, db, "zamestnanec@forestshop.sk", "manazer");
    // B vidí úlohu A (autor A)
    const bRows = await listRows(app, other.cookie);
    expect(bRows.map((r) => r.text)).toEqual(["šéfova úloha na odfajknutie"]);
    expect(bRows[0]?.authorName).toBe("sef@forestshop.sk");
    // B ju odfajkne
    const markDone = await app.request(`/api/daily-tasks/${id}/done`, { method: "POST", headers: { cookie: other.cookie, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
    expect((await markDone.json()) as { ok: boolean; updated: boolean }).toEqual({ ok: true, updated: true });
    // A vidí, že je vybavená
    const aRows = await listRows(app, cookie);
    expect(aRows[0]?.doneAt).not.toBeNull();
  });
});

describe("DELETE /api/daily-tasks/:id", () => {
  it("okamžite odstráni úlohu", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const create = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Na zmazanie" }) });
    const { id } = (await create.json()) as { id: string };

    const del = await app.request(`/api/daily-tasks/${id}`, { method: "DELETE", headers: { cookie } });
    expect((await del.json()) as { removed: boolean }).toEqual({ ok: true, removed: true });

    expect(await listRows(app, cookie)).toEqual([]);
  });

  it("neznáme id vráti 200 {removed:false}, nikdy chybu", async () => {
    const { app, cookie } = await bootUser("sef@forestshop.sk", "admin");
    const res = await app.request("/api/daily-tasks/00000000-0000-0000-0000-000000000000", { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; removed: boolean }).toEqual({ ok: true, removed: false });
  });

  // issue 487: prepísané z IDOR testu — zdieľaný zoznam, iný účet MÔŽE zmazať.
  it("ZDIEĽANÉ — iný účet MÔŽE zmazať úlohu prvého účtu (removed:true)", async () => {
    const { app, cookie, db } = await bootUser("sef@forestshop.sk", "admin");
    const create = await app.request("/api/daily-tasks", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "Šéfova úloha" }) });
    const { id } = (await create.json()) as { id: string };

    const other = await secondLogin(app, db, "zamestnanec@forestshop.sk", "manazer");
    const del = await app.request(`/api/daily-tasks/${id}`, { method: "DELETE", headers: { cookie: other.cookie } });
    expect((await del.json()) as { removed: boolean }).toEqual({ ok: true, removed: true });

    expect(await listRows(app, cookie)).toEqual([]);
  });
});

// issue 473 + 487: odznak počtu v ľavom menu — počet otvorených úloh VŠETKÝCH účtov.
describe("GET /api/daily-tasks/count", () => {
  it("bez prihlásenia vráti 401", async () => {
    const { app } = await bootUser("sef@forestshop.sk", "admin");
    const res = await app.request("/api/daily-tasks/count");
    expect(res.status).toBe(401);
  });

  it("prázdna DB → count 0", async () => {
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

  // issue 487: prepísané z "count je PER-POUŽÍVATEĽ" — teraz ZDIEĽANÝ.
  it("count je ZDIEĽANÝ — počíta otvorené úlohy VŠETKÝCH účtov; oba účty vidia rovnaké číslo", async () => {
    const { app, cookie, db } = await bootUser("sef@forestshop.sk", "admin");
    await createTask(app, cookie, "šéfova 1");
    await createTask(app, cookie, "šéfova 2");

    const other = await secondLogin(app, db, "zamestnanec@forestshop.sk", "manazer");
    // Druhý účet vidí ROVNAKÝ počet (zdieľané), nie 0 ako pri per-user.
    expect(await readCount(app, other.cookie)).toBe(2);
    expect(await readCount(app, cookie)).toBe(2);
    // A keď B pridá vlastnú úlohu, A vidí zvýšený počet.
    await createTask(app, other.cookie, "kolegova 1");
    expect(await readCount(app, cookie)).toBe(3);
  });
});
