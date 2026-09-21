import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { auditEvents, floorNoteProducts, floorNotes, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 575: stav + poznámka predajňovej položky v board-e „Na objednanie" —
// vlastný súbor (eslint `max-lines: 400`, rovnaký dôvod ako
// `floor-notes-products-http.integration.test.ts`).
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

async function attach(app: ReturnType<typeof createApp>, cookie: string, id: string, variantCode: string): Promise<void> {
  await app.request(`/api/floor-notes/${id}/products`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode }),
  });
}

describe("POST /api/floor-notes/:id/products/:variantCode/state", () => {
  it("nastaví stav položky, GET zoznamu ho vráti a zapíše sa audit riadok", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-ST-1");
    const id = await createNote(app, cookie, "zápis");
    await attach(app, cookie, id, "E2E-ST-1");

    const res = await app.request(`/api/floor-notes/${id}/products/${encodeURIComponent("E2E-ST-1")}/state`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ state: "riesit" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; state: string }).toEqual({ ok: true, state: "riesit" });

    // Perzistované — GET zoznamu vráti stav položky.
    const list = await app.request("/api/floor-notes", { headers: { cookie } });
    const row = ((await list.json()) as { rows: readonly { id: string; products: readonly { variantCode: string; state: string }[] }[] }).rows.find((r) => r.id === id);
    expect(row?.products[0]?.state).toBe("riesit");

    // Audit riadok s from/to.
    const [productRow] = await db
      .select({ pid: floorNoteProducts.id })
      .from(floorNoteProducts)
      .where(and(eq(floorNoteProducts.floorNoteId, id), eq(floorNoteProducts.variantCode, "E2E-ST-1")));
    const audit = await db
      .select({ action: auditEvents.action, entity: auditEvents.entity, data: auditEvents.data })
      .from(auditEvents)
      .where(eq(auditEvents.action, "floor_note_product.state.changed"));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.entity).toBe("floor_note_product");
    expect(audit[0]?.data).toMatchObject({ variantCode: "E2E-ST-1", from: "objednane", to: "riesit" });
    expect(productRow).toBeDefined();
  });

  it("neplatná hodnota stavu vráti 400 (zod enum)", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-ST-2");
    const id = await createNote(app, cookie, "zápis");
    await attach(app, cookie, id, "E2E-ST-2");

    const res = await app.request(`/api/floor-notes/${id}/products/${encodeURIComponent("E2E-ST-2")}/state`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ state: "vymyslene" }),
    });
    expect(res.status).toBe(400);
  });

  it("neznáma dvojica (zápis, variant) vráti 404", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const id = await createNote(app, cookie, "zápis");

    const res = await app.request(`/api/floor-notes/${id}/products/${encodeURIComponent("NEEXISTUJE")}/state`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ state: "riesit" }),
    });
    expect(res.status).toBe(404);
  });

  it("rola citanie dostane 403 (zápis je gejtovaný admin/manazer)", async () => {
    const { app, cookie, db } = await bootUser("citanie@forestshop.sk", "citanie");
    await insertTestVariant(db, "E2E-ST-3");
    // Zápis aj pripnutie potrebujú admin/manazer — pre rolu citanie ich vlož
    // priamo cez DB, aby sme izolovane overili gating SAMOTNEJ „state" trasy.
    const [note] = await db.insert(floorNotes).values({ text: "zápis", createdAt: new Date(), updatedAt: new Date() }).returning({ id: floorNotes.id });
    if (note === undefined) throw new Error("insert zápisu zlyhal");
    const id = note.id;
    await db.insert(floorNoteProducts).values({ floorNoteId: id, variantCode: "E2E-ST-3", quantity: 1, createdAt: new Date() });

    const res = await app.request(`/api/floor-notes/${id}/products/${encodeURIComponent("E2E-ST-3")}/state`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ state: "riesit" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/floor-notes/:id/products/:variantCode/comment", () => {
  it("uloží poznámku, GET zoznamu ju vráti a zapíše audit; prázdna ju vymaže na null", async () => {
    const { app, cookie, db } = await bootUser("manazer@forestshop.sk", "manazer");
    await insertTestVariant(db, "E2E-CM-1");
    const id = await createNote(app, cookie, "zápis");
    await attach(app, cookie, id, "E2E-CM-1");

    const res = await app.request(`/api/floor-notes/${id}/products/${encodeURIComponent("E2E-CM-1")}/comment`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ comment: "  objednať u dodávateľa  " }),
    });
    expect(res.status).toBe(200);
    // Trim na trase, uložené bez okrajových medzier.
    expect((await res.json()) as { ok: boolean; comment: string | null }).toEqual({ ok: true, comment: "objednať u dodávateľa" });

    const list = await app.request("/api/floor-notes", { headers: { cookie } });
    const row = ((await list.json()) as { rows: readonly { id: string; products: readonly { comment: string | null }[] }[] }).rows.find((r) => r.id === id);
    expect(row?.products[0]?.comment).toBe("objednať u dodávateľa");

    const audit = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.action, "floor_note_product.comment.changed"));
    expect(audit).toHaveLength(1);

    // Prázdny reťazec → null.
    const clear = await app.request(`/api/floor-notes/${id}/products/${encodeURIComponent("E2E-CM-1")}/comment`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ comment: "   " }),
    });
    expect((await clear.json()) as { comment: string | null }).toEqual({ ok: true, comment: null });
    const list2 = await app.request("/api/floor-notes", { headers: { cookie } });
    const row2 = ((await list2.json()) as { rows: readonly { id: string; products: readonly { comment: string | null }[] }[] }).rows.find((r) => r.id === id);
    expect(row2?.products[0]?.comment).toBeNull();
  });

  it("neznáma dvojica vráti 404", async () => {
    const { app, cookie } = await bootUser("manazer@forestshop.sk", "manazer");
    const id = await createNote(app, cookie, "zápis");

    const res = await app.request(`/api/floor-notes/${id}/products/${encodeURIComponent("NEEXISTUJE")}/comment`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ comment: "x" }),
    });
    expect(res.status).toBe(404);
  });
});
