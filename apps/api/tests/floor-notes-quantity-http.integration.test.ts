import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { floorNoteProducts, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 453: počet kusov pri pripnutom produkte. Vyčlenené do VLASTNÉHO
// súboru (rovnaký dôvod ako `floor-notes-products-http.integration.test.ts`'s
// vlastný komentár — eslint `max-lines: 400`).
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
  return ((await res.json()) as { id: string }).id;
}

async function attach(app: ReturnType<typeof createApp>, cookie: string, id: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(`/api/floor-notes/${id}/products`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function firstProduct(app: ReturnType<typeof createApp>, cookie: string, id: string): Promise<{ variantCode: string; quantity: number } | undefined> {
  const list = await app.request("/api/floor-notes", { headers: { cookie } });
  const rows = ((await list.json()) as { rows: readonly { id: string; products: readonly { variantCode: string; quantity: number }[] }[] }).rows;
  return rows.find((r) => r.id === id)?.products[0];
}

describe("POST /api/floor-notes/:id/products — počet kusov (issue 453)", () => {
  it("pripne s explicitným počtom 2 a zoznam ho vráti", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-QTY-1");
    const id = await createNote(app, cookie, "zápis");

    const res = await attach(app, cookie, id, { variantCode: "E2E-QTY-1", quantity: 2 });
    expect(res.status).toBe(200);
    expect(await firstProduct(app, cookie, id)).toMatchObject({ variantCode: "E2E-QTY-1", quantity: 2 });
  });

  it("pripne BEZ počtu → default 1", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-QTY-2");
    const id = await createNote(app, cookie, "zápis");

    const res = await attach(app, cookie, id, { variantCode: "E2E-QTY-2" });
    expect(res.status).toBe(200);
    expect((await firstProduct(app, cookie, id))?.quantity).toBe(1);
  });

  it("počet 0 / -1 / necelé číslo → 400 (zod int().min(1))", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-QTY-3");
    const id = await createNote(app, cookie, "zápis");

    for (const bad of [0, -1, 1.5]) {
      const res = await attach(app, cookie, id, { variantCode: "E2E-QTY-3", quantity: bad });
      expect(res.status).toBe(400);
    }
    // Žiadny z neplatných pokusov nepripol nič.
    expect(await firstProduct(app, cookie, id)).toBeUndefined();
  });

  it("priamy DB insert bez quantity dostane stĺpcový default 1 (dôkaz backfillu existujúcich riadkov)", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-QTY-4");
    const id = await createNote(app, cookie, "zápis");

    await db.insert(floorNoteProducts).values({ floorNoteId: id, variantCode: "E2E-QTY-4", createdAt: new Date() });
    const [row] = await db.select({ quantity: floorNoteProducts.quantity }).from(floorNoteProducts).where(eq(floorNoteProducts.floorNoteId, id));
    expect(row?.quantity).toBe(1);
  });
});

describe("PATCH /api/floor-notes/:id/products/:variantCode/quantity — úprava počtu (issue 453)", () => {
  async function patchQuantity(app: ReturnType<typeof createApp>, cookie: string, id: string, variantCode: string, body: Record<string, unknown>): Promise<Response> {
    return app.request(`/api/floor-notes/${id}/products/${encodeURIComponent(variantCode)}/quantity`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("upraví počet už pripnutého produktu; zoznam vráti novú hodnotu", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-QTY-5");
    const id = await createNote(app, cookie, "zápis");
    await attach(app, cookie, id, { variantCode: "E2E-QTY-5", quantity: 1 });

    const res = await patchQuantity(app, cookie, id, "E2E-QTY-5", { quantity: 4 });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; updated: boolean }).toEqual({ ok: true, updated: true });
    expect((await firstProduct(app, cookie, id))?.quantity).toBe(4);
  });

  it("kód s '/' (veľkosť) cez zakódovanú cestu funguje", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-QTY-6/L");
    const id = await createNote(app, cookie, "zápis");
    await attach(app, cookie, id, { variantCode: "E2E-QTY-6/L", quantity: 1 });

    const res = await patchQuantity(app, cookie, id, "E2E-QTY-6/L", { quantity: 3 });
    expect(res.status).toBe(200);
    expect((await firstProduct(app, cookie, id))?.quantity).toBe(3);
  });

  it("neplatný počet (0) → 400, hodnota sa nezmení", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-QTY-7");
    const id = await createNote(app, cookie, "zápis");
    await attach(app, cookie, id, { variantCode: "E2E-QTY-7", quantity: 2 });

    const res = await patchQuantity(app, cookie, id, "E2E-QTY-7", { quantity: 0 });
    expect(res.status).toBe(400);
    expect((await firstProduct(app, cookie, id))?.quantity).toBe(2);
  });

  it("nepripnutý produkt → {updated:false}, nikdy chyba", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-QTY-8");
    const id = await createNote(app, cookie, "zápis");

    const res = await patchQuantity(app, cookie, id, "E2E-QTY-8", { quantity: 3 });
    expect(res.status).toBe(200);
    expect((await res.json()) as { updated: boolean }).toEqual({ ok: true, updated: false });
  });

  it("rola 'citanie' NESMIE upraviť počet (403)", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-QTY-9");
    const id = await createNote(app, cookie, "zápis");
    await attach(app, cookie, id, { variantCode: "E2E-QTY-9", quantity: 1 });
    await db.insert(users).values({ email: "citac@forestshop.sk", passwordHash: await hashPassword(HESLO), displayName: "Čitač", role: "citanie" });
    const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "citac@forestshop.sk", password: HESLO }) });
    const citacCookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const res = await patchQuantity(app, citacCookie, id, "E2E-QTY-9", { quantity: 5 });
    expect(res.status).toBe(403);
  });
});
