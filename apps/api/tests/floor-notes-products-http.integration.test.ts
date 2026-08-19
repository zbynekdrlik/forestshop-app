import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { floorNoteProducts, shopProductUrl, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 410: pripínanie/odopínanie produktov na zápis "Objednávky
// predajňa" — vyčlenené do VLASTNÉHO súboru, rovnaký dôvod ako
// `floor-notes-http.integration.test.ts`'s vlastný komentár (eslint
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

async function createNote(app: ReturnType<typeof createApp>, cookie: string, text: string): Promise<string> {
  const res = await app.request("/api/floor-notes", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = (await res.json()) as { id: string };
  return body.id;
}

describe("POST /api/floor-notes/:id/products", () => {
  it("pripne existujúci produkt, GET zoznamu ho vráti VRÁTANE priamej shop_product_url adresy", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-PIN-1");
    await db.insert(shopProductUrl).values({ code: "E2E-PIN-1", url: "https://www.forestshop.sk/pin-1/", fetchedAt: new Date() });
    const id = await createNote(app, cookie, "zápis");

    const res = await app.request(`/api/floor-notes/${id}/products`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ variantCode: "E2E-PIN-1" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });

    const list = await app.request("/api/floor-notes", { headers: { cookie } });
    const row = ((await list.json()) as { rows: readonly { id: string; products: readonly { variantCode: string; quantity: number; shopUrl: string | null }[] }[] }).rows.find((r) => r.id === id);
    // issue 453: pripnutie bez počtu dostane default 1 (dôkaz defaultu na čítacej ceste).
    expect(row?.products).toEqual([{ variantCode: "E2E-PIN-1", productName: "Test produkt E2E-PIN-1", sizeLabel: null, quantity: 1, shopUrl: "https://www.forestshop.sk/pin-1/" }]);
  });

  it("pripnutý produkt BEZ shop_product_url riadku má shopUrl:null (frontend rieši náhradný odkaz)", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-PIN-2");
    const id = await createNote(app, cookie, "zápis");

    await app.request(`/api/floor-notes/${id}/products`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ variantCode: "E2E-PIN-2" }) });

    const list = await app.request("/api/floor-notes", { headers: { cookie } });
    const row = ((await list.json()) as { rows: readonly { products: readonly { shopUrl: string | null }[] }[] }).rows[0];
    expect(row?.products[0]?.shopUrl).toBeNull();
  });

  it("neznámy variantCode vráti 404 (overuje SÁM SEBA, nespolieha sa len na frontend)", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const id = await createNote(app, cookie, "zápis");

    const res = await app.request(`/api/floor-notes/${id}/products`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ variantCode: "NEEXISTUJE" }),
    });
    expect(res.status).toBe(404);
  });

  it("neznáme id zápisu vráti 404", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-PIN-3");

    const res = await app.request("/api/floor-notes/00000000-0000-0000-0000-000000000000/products", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ variantCode: "E2E-PIN-3" }),
    });
    expect(res.status).toBe(404);
  });

  it("opakované pripnutie TOHO ISTÉHO produktu je idempotentné — 200 ok, žiadny duplicitný riadok", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-PIN-4");
    const id = await createNote(app, cookie, "zápis");

    await app.request(`/api/floor-notes/${id}/products`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ variantCode: "E2E-PIN-4" }) });
    const second = await app.request(`/api/floor-notes/${id}/products`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ variantCode: "E2E-PIN-4" }),
    });
    expect(second.status).toBe(200);

    const list = await app.request("/api/floor-notes", { headers: { cookie } });
    const row = ((await list.json()) as { rows: readonly { products: readonly unknown[] }[] }).rows[0];
    expect(row?.products).toHaveLength(1);
  });

  it("rola 'citanie' NESMIE pripnúť produkt (403)", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-PIN-5");
    const id = await createNote(app, cookie, "zápis");
    await db.insert(users).values({ email: "citac@forestshop.sk", passwordHash: await hashPassword(HESLO), displayName: "Čitač", role: "citanie" });
    const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "citac@forestshop.sk", password: HESLO }) });
    const citacCookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const res = await app.request(`/api/floor-notes/${id}/products`, {
      method: "POST",
      headers: { cookie: citacCookie, "content-type": "application/json" },
      body: JSON.stringify({ variantCode: "E2E-PIN-5" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/floor-notes/:id/products/:variantCode", () => {
  it("odopne pripnutý produkt", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-PIN-6");
    const id = await createNote(app, cookie, "zápis");
    await app.request(`/api/floor-notes/${id}/products`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ variantCode: "E2E-PIN-6" }) });

    const res = await app.request(`/api/floor-notes/${id}/products/E2E-PIN-6`, { method: "DELETE", headers: { cookie } });
    expect((await res.json()) as { ok: boolean; removed: boolean }).toEqual({ ok: true, removed: true });

    const list = await app.request("/api/floor-notes", { headers: { cookie } });
    const row = ((await list.json()) as { rows: readonly { products: readonly unknown[] }[] }).rows[0];
    expect(row?.products).toEqual([]);
  });

  it("odopnutie nepripnutého produktu vráti {removed:false}, nikdy chybu", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const id = await createNote(app, cookie, "zápis");

    const res = await app.request(`/api/floor-notes/${id}/products/NEBOL-PRIPNUTY`, { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { removed: boolean }).toEqual({ ok: true, removed: false });
  });

  // Code review (issue 410): variantové kódy v tejto appke bežne nesú
  // veľkosť za lomítkom ("40237/L", `.claude/rules/database.md`'s
  // `variant.code` komentár) — frontend (`floorNotesApi.ts`) preto pošle
  // `encodeURIComponent(variantCode)` ako súčasť cesty (`%2F`). Over, že
  // Hono-ov `:variantCode` param dostane SPÄŤ dekódovanú hodnotu s
  // LOMÍTKOM, nie skrátený/rozdelený segment.
  it("odopnutie produktu, ktorého kód obsahuje '/' (veľkosť), funguje cez zakódovanú cestu", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-PIN-8/L");
    const id = await createNote(app, cookie, "zápis");
    await app.request(`/api/floor-notes/${id}/products`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ variantCode: "E2E-PIN-8/L" }),
    });

    const res = await app.request(`/api/floor-notes/${id}/products/${encodeURIComponent("E2E-PIN-8/L")}`, { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()) as { removed: boolean }).toEqual({ ok: true, removed: true });

    const list = await app.request("/api/floor-notes", { headers: { cookie } });
    const row = ((await list.json()) as { rows: readonly { products: readonly unknown[] }[] }).rows[0];
    expect(row?.products).toEqual([]);
  });
});

describe("zmazanie zápisu odstráni aj jeho pripnuté produkty (cascade)", () => {
  it("po DELETE .../floor-notes/:id zápis aj jeho pripnuté produkty zmiznú zo zoznamu A z floor_note_product tabuľky", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-PIN-7");
    const id = await createNote(app, cookie, "zápis s produktom");
    await app.request(`/api/floor-notes/${id}/products`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ variantCode: "E2E-PIN-7" }) });

    const del = await app.request(`/api/floor-notes/${id}`, { method: "DELETE", headers: { cookie } });
    expect((await del.json()) as { removed: boolean }).toEqual({ ok: true, removed: true });

    const list = await app.request("/api/floor-notes", { headers: { cookie } });
    expect(((await list.json()) as { rows: readonly unknown[] }).rows).toEqual([]);

    // Code review (issue 410): overiť PRIAMO v DB, že `floor_note_product`
    // riadok skutočne ZMIZOL (cascade), nie len že ho zoznam nezobrazuje —
    // zoznam by mlčal aj pri osirotenom riadku bez zodpovedajúceho zápisu.
    const zvysneRiadky = await db.select().from(floorNoteProducts).where(eq(floorNoteProducts.floorNoteId, id));
    expect(zvysneRiadky).toEqual([]);
  });
});
