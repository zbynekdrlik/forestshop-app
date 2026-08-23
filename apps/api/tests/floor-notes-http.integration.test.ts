import { afterEach, describe, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { withCleanDb } from "./helpers/db.js";

// issue 410: "Eshop → Objednávky predajňa" — nahrádza Shoptet-viazané
// `floor-orders-http.integration.test.ts`. Rozdelené na tento súbor
// (zoznam/text/značky/mazanie) + `floor-notes-products-http.integration
// .test.ts` (pripínanie produktov) — rovnaký dôvod ako `orders-http`/
// `orders-http-state` split (`.claude/rules/testing.md`, eslint
// `max-lines: 400`).
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

// Druhý používateľ v TEJ ISTEJ (už čistej) DB — rovnaký vzor ako
// `daily-tasks-http.integration.test.ts`'s `secondLogin` (žiadne ďalšie
// `withCleanDb()` volanie, `.claude/rules/testing.md`'s "dva boot()-štýl
// helpery sa navzájom prepíšu").
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

async function createNote(app: ReturnType<typeof createApp>, cookie: string, text: string): Promise<string> {
  const res = await app.request("/api/floor-notes", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function setMarker(app: ReturnType<typeof createApp>, cookie: string, id: string, marker: "resolved" | "ordered" | "called", value: boolean): Promise<void> {
  await app.request(`/api/floor-notes/${id}/${marker}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ value }) });
}

async function readCount(app: ReturnType<typeof createApp>, cookie: string): Promise<number> {
  const res = await app.request("/api/floor-notes/count", { headers: { cookie } });
  return ((await res.json()) as { count: number }).count;
}

describe("GET /api/floor-notes", () => {
  it("bez prihlásenia vráti 401", async () => {
    const { app } = await bootUser("manazer@forestshop.sk", "manazer");
    const res = await app.request("/api/floor-notes");
    expect(res.status).toBe(401);
  });

  it("čerstvá appka má prázdny zoznam", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const res = await app.request("/api/floor-notes", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rows: readonly unknown[] }).rows).toEqual([]);
  });

  it("zoznam je zoradený najnovšie hore", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    await createNote(app, cookie, "prvý zápis");
    await createNote(app, cookie, "druhý zápis");

    const res = await app.request("/api/floor-notes", { headers: { cookie } });
    const body = (await res.json()) as { rows: readonly { text: string }[] };
    expect(body.rows.map((r) => r.text)).toEqual(["druhý zápis", "prvý zápis"]);
  });

  it("rola 'citanie' vidí zoznam (čítanie nie je gejtované)", async () => {
    const { app, cookie } = await bootUser("citac@forestshop.sk", "citanie");
    const res = await app.request("/api/floor-notes", { headers: { cookie } });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/floor-notes", () => {
  it("vytvorí zápis s predvolenými značkami false", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const res = await app.request("/api/floor-notes", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "Matúš Dubec, 0949 647 802" }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { ok: boolean; id: string };
    expect(created.ok).toBe(true);

    const list = await app.request("/api/floor-notes", { headers: { cookie } });
    const body = (await list.json()) as {
      rows: readonly { id: string; text: string; resolved: boolean; ordered: boolean; called: boolean; products: readonly unknown[] }[];
    };
    expect(body.rows[0]).toMatchObject({ id: created.id, text: "Matúš Dubec, 0949 647 802", resolved: false, ordered: false, called: false, products: [] });
  });

  it("prázdny text je odmietnutý (400)", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const res = await app.request("/api/floor-notes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "   " }) });
    expect(res.status).toBe(400);
  });

  it("rola 'citanie' NESMIE vytvoriť zápis (403)", async () => {
    const { app, cookie } = await bootUser("citac@forestshop.sk", "citanie");
    const res = await app.request("/api/floor-notes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "pokus" }) });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/floor-notes/:id/text", () => {
  it("upraví text zápisu", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const id = await createNote(app, cookie, "pôvodný text");

    const patch = await app.request(`/api/floor-notes/${id}/text`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "upravený text" }) });
    expect((await patch.json()) as { ok: boolean; updated: boolean }).toEqual({ ok: true, updated: true });

    const list = await app.request("/api/floor-notes", { headers: { cookie } });
    expect(((await list.json()) as { rows: readonly { text: string }[] }).rows[0]?.text).toBe("upravený text");
  });

  it("neznáme id vráti 200 {updated:false}, nikdy chybu", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const res = await app.request("/api/floor-notes/00000000-0000-0000-0000-000000000000/text", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: "text" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { updated: boolean }).toEqual({ ok: true, updated: false });
  });
});

describe("tri nezávislé značky (POST .../resolved|ordered|called)", () => {
  it("každá značka sa prepína NEZÁVISLE od ostatných dvoch", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const id = await createNote(app, cookie, "zápis");

    const setResolved = await app.request(`/api/floor-notes/${id}/resolved`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ value: true }) });
    expect((await setResolved.json()) as { updated: boolean }).toEqual({ ok: true, updated: true });

    const list = await app.request("/api/floor-notes", { headers: { cookie } });
    const row = ((await list.json()) as { rows: readonly { resolved: boolean; ordered: boolean; called: boolean }[] }).rows[0];
    expect(row).toMatchObject({ resolved: true, ordered: false, called: false });
  });

  it("'ordered' a 'called' sa dajú nastaviť naraz (nie je to enum s jednou hodnotou)", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const id = await createNote(app, cookie, "zápis");

    await app.request(`/api/floor-notes/${id}/ordered`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ value: true }) });
    await app.request(`/api/floor-notes/${id}/called`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ value: true }) });

    const list = await app.request("/api/floor-notes", { headers: { cookie } });
    const row = ((await list.json()) as { rows: readonly { resolved: boolean; ordered: boolean; called: boolean }[] }).rows[0];
    expect(row).toMatchObject({ resolved: false, ordered: true, called: true });
  });

  it("vypnutie značky späť na false funguje", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const id = await createNote(app, cookie, "zápis");
    await app.request(`/api/floor-notes/${id}/called`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ value: true }) });
    await app.request(`/api/floor-notes/${id}/called`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ value: false }) });

    const list = await app.request("/api/floor-notes", { headers: { cookie } });
    const row = ((await list.json()) as { rows: readonly { called: boolean }[] }).rows[0];
    expect(row?.called).toBe(false);
  });

  it("rola 'citanie' NESMIE prepnúť značku (403)", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    const id = await createNote(app, cookie, "zápis");
    const other = await secondLogin(app, db, "citac@forestshop.sk", "citanie");

    const res = await app.request(`/api/floor-notes/${id}/resolved`, { method: "POST", headers: { cookie: other.cookie, "content-type": "application/json" }, body: JSON.stringify({ value: true }) });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/floor-notes/:id", () => {
  it("okamžite odstráni zápis", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const id = await createNote(app, cookie, "na zmazanie");

    const del = await app.request(`/api/floor-notes/${id}`, { method: "DELETE", headers: { cookie } });
    expect((await del.json()) as { removed: boolean }).toEqual({ ok: true, removed: true });

    const list = await app.request("/api/floor-notes", { headers: { cookie } });
    expect(((await list.json()) as { rows: readonly unknown[] }).rows).toEqual([]);
  });

  it("neznáme id vráti 200 {removed:false}, nikdy chybu", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const res = await app.request("/api/floor-notes/00000000-0000-0000-0000-000000000000", { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; removed: boolean }).toEqual({ ok: true, removed: false });
  });

  it("rola 'citanie' NESMIE zmazať zápis (403)", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    const id = await createNote(app, cookie, "zápis");
    const other = await secondLogin(app, db, "citac@forestshop.sk", "citanie");

    const res = await app.request(`/api/floor-notes/${id}`, { method: "DELETE", headers: { cookie: other.cookie } });
    expect(res.status).toBe(403);
  });

  // Pripnuté produkty (`floor_note_product`) miznú AUTOMATICKY cez
  // `onDelete: "cascade"` (`schema-floor-notes.ts`) — dôkaz je v
  // `floor-notes-products-http.integration.test.ts`, tematicky patrí tam
  // (ten súbor produkty aj vkladá).
});

// issue 473: odznak počtu v ľavom menu — počet nevybavených (`resolved=false`)
// zápisov, globálne. Značky 🛒 objednané / 📞 zavolané do počtu NEVSTUPUJÚ.
describe("GET /api/floor-notes/count", () => {
  it("bez prihlásenia vráti 401", async () => {
    const { app } = await bootUser("manazer@forestshop.sk", "manazer");
    const res = await app.request("/api/floor-notes/count");
    expect(res.status).toBe(401);
  });

  it("čerstvá appka má count 0", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const res = await app.request("/api/floor-notes/count", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { count: number }).toEqual({ count: 0 });
  });

  it("počíta LEN nevybavené (resolved=false) zápisy — vybavený sa neráta", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const a = await createNote(app, cookie, "A");
    await createNote(app, cookie, "B");
    await createNote(app, cookie, "C");
    await setMarker(app, cookie, a, "resolved", true);

    expect(await readCount(app, cookie)).toBe(2);
  });

  it("prepnutie ✅ vybavené a späť mení count OBOMA smermi", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const id = await createNote(app, cookie, "zápis");
    expect(await readCount(app, cookie)).toBe(1);

    await setMarker(app, cookie, id, "resolved", true);
    expect(await readCount(app, cookie)).toBe(0);

    await setMarker(app, cookie, id, "resolved", false);
    expect(await readCount(app, cookie)).toBe(1);
  });

  it("značky 🛒 objednané / 📞 zavolané NEMENIA count (do počtu vstupuje len ✅ vybavené)", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const id = await createNote(app, cookie, "zápis");
    await setMarker(app, cookie, id, "ordered", true);
    await setMarker(app, cookie, id, "called", true);

    expect(await readCount(app, cookie)).toBe(1);
  });

  it("count je GLOBÁLNY (zdieľaný) — zápis jedného vidí v počte aj druhý používateľ", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await createNote(app, cookie, "spoločný zápis");

    const other = await secondLogin(app, db, "kolega@forestshop.sk", "manazer");
    expect(await readCount(app, other.cookie)).toBe(1);
  });
});
