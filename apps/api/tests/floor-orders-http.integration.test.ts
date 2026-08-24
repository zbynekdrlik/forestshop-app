import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { auditEvents, floorNoteProducts, floorNotes, orderLines, orderOpenStatuses, orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { buildSupplierOrderMailContent } from "../src/modules/orders/mail.js";
import { NEZNAMY_DODAVATEL } from "../src/modules/orders/queries.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 480: predajňové (floor) riadky v board-e „Na objednanie" — produkty
// pripnuté na nevybavených zápisoch „Objednávky predajňa", zaradené pod svojho
// dodávateľa; per-item + hromadné „objednané"; 🛒 auto-set; vylúčenie z e-mailu;
// filter „Riešiť". Model harnessu je zhodný s `orders-http-ordered.integration
// .test.ts`.

const HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot(role: UserRole) {
  const ctx = await withCleanDb();
  close = ctx.close;
  const [pouzivatel] = await ctx.db
    .insert(users)
    .values({ email: "manazer@forestshop.sk", passwordHash: await hashPassword(HESLO), displayName: "Manažér", role })
    .returning({ id: users.id });
  if (pouzivatel === undefined) throw new Error("testovací používateľ sa nepodarilo vložiť");
  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db, userId: pouzivatel.id };
}

type Db = Awaited<ReturnType<typeof boot>>["db"];
type App = Awaited<ReturnType<typeof boot>>["app"];

async function createNote(app: App, cookie: string, text: string): Promise<string> {
  const res = await app.request("/api/floor-notes", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return ((await res.json()) as { id: string }).id;
}

async function attach(app: App, cookie: string, noteId: string, variantCode: string, quantity = 1): Promise<void> {
  const res = await app.request(`/api/floor-notes/${noteId}/products`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode, quantity }),
  });
  if (res.status !== 200) throw new Error(`attach zlyhal: ${String(res.status)}`);
}

interface BoardGroup {
  readonly supplier: string;
  readonly lines: readonly { readonly lineId: string; readonly ordered: boolean }[];
  readonly floorRows: readonly {
    readonly noteId: string;
    readonly variantCode: string;
    readonly productName: string;
    readonly customerName: string;
    readonly quantity: number;
    readonly ordered: boolean;
    readonly createdAt: string;
  }[];
}

async function board(app: App, cookie: string, path = "/api/orders/open"): Promise<readonly BoardGroup[]> {
  const res = await app.request(path, { headers: { cookie } });
  return ((await res.json()) as { suppliers: readonly BoardGroup[] }).suppliers;
}

let poradie = 0;
async function insertOrderLine(db: Db, supplier: string | null, code?: string): Promise<{ orderId: string; lineId: string }> {
  poradie += 1;
  const kod = code ?? `OL-${String(poradie)}`;
  await insertTestVariant(db, kod, supplier);
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: `900${String(poradie)}`, customerName: "Zákazník", placedAt: new Date("2026-07-20T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert objednávky zlyhal");
  const [riadok] = await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: kod, quantity: 1 }).returning();
  if (riadok === undefined) throw new Error("insert riadku zlyhal");
  return { orderId: objednavka.id, lineId: riadok.id };
}

it("pripnutý produkt nevybaveného zápisu sa objaví v Na objednanie pod svojím dodávateľom", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "FLOOR-A", "Dodávateľ Alfa");
  const noteId = await createNote(app, cookie, "Jozko Mrkvička\ntel 0900");
  await attach(app, cookie, noteId, "FLOOR-A", 3);

  const groups = await board(app, cookie);
  const alfa = groups.find((g) => g.supplier === "Dodávateľ Alfa");
  expect(alfa).toBeDefined();
  expect(alfa?.floorRows).toHaveLength(1);
  const row = alfa?.floorRows[0];
  expect(row?.variantCode).toBe("FLOOR-A");
  expect(row?.noteId).toBe(noteId);
  // Meno = PRVÝ riadok textu zápisu, orezaný.
  expect(row?.customerName).toBe("Jozko Mrkvička");
  expect(row?.quantity).toBe(3);
  expect(row?.ordered).toBe(false);
  expect(row?.productName).toBe("Test produkt FLOOR-A");
});

it("produkt bez dodávateľa spadne do skupiny '(bez dodávateľa)'", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "FLOOR-NIL", null);
  const noteId = await createNote(app, cookie, "Bezmenný");
  await attach(app, cookie, noteId, "FLOOR-NIL");

  const groups = await board(app, cookie);
  const neznamy = groups.find((g) => g.supplier === NEZNAMY_DODAVATEL);
  expect(neznamy?.floorRows.map((r) => r.variantCode)).toEqual(["FLOOR-NIL"]);
});

it("predajňový riadok a riadok objednávky toho istého dodávateľa sú v JEDNEJ skupine", async () => {
  const { app, cookie, db } = await boot("manazer");
  // `withCleanDb()` seeduje otvorený stav „Vybavuje sa" (= default `order
  // .status_name`), takže order riadok sa v board-e zobrazí bez ďalšieho setupu.
  const { lineId } = await insertOrderLine(db, "Spol Dodávateľ");
  await insertTestVariant(db, "FLOOR-SPOL", "Spol Dodávateľ");
  const noteId = await createNote(app, cookie, "Spoločný zákazník");
  await attach(app, cookie, noteId, "FLOOR-SPOL");

  const groups = await board(app, cookie);
  const spol = groups.find((g) => g.supplier === "Spol Dodávateľ");
  expect(spol?.lines.map((l) => l.lineId)).toContain(lineId);
  expect(spol?.floorRows.map((r) => r.variantCode)).toEqual(["FLOOR-SPOL"]);
});

it("manažér odškrtne predajňový riadok ako objednaný, zápis sa uloží aj do auditu; späť tiež", async () => {
  const { app, cookie, db, userId } = await boot("manazer");
  await insertTestVariant(db, "FLOOR-ORD", "Dod");
  const noteId = await createNote(app, cookie, "X");
  await attach(app, cookie, noteId, "FLOOR-ORD");

  const res = await app.request(`/api/floor-notes/${noteId}/products/FLOOR-ORD/ordered`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ value: true }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, ordered: true });

  const [p] = await db.select().from(floorNoteProducts).where(eq(floorNoteProducts.variantCode, "FLOOR-ORD"));
  expect(p?.orderedAt).not.toBeNull();

  const ev = (await db.select().from(auditEvents)).find((e) => e.action === "floor_note_product.ordered.changed");
  expect(ev).toBeDefined();
  expect(ev?.actorUserId).toBe(userId);
  expect(ev?.entity).toBe("floor_note_product");
  expect(ev?.data).toMatchObject({ floorNoteId: noteId, variantCode: "FLOOR-ORD", from: false, to: true });

  const zrus = await app.request(`/api/floor-notes/${noteId}/products/FLOOR-ORD/ordered`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ value: false }),
  });
  expect(zrus.status).toBe(200);
  const [p2] = await db.select().from(floorNoteProducts).where(eq(floorNoteProducts.variantCode, "FLOOR-ORD"));
  expect(p2?.orderedAt).toBeNull();
});

it("keď sú objednané VŠETKY produkty zápisu, floor_note.ordered (🛒) sa nastaví; odškrtnutie ho zhodí", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "FLOOR-M1", "Dod");
  await insertTestVariant(db, "FLOOR-M2", "Dod");
  const noteId = await createNote(app, cookie, "Dvojprodukt");
  await attach(app, cookie, noteId, "FLOOR-M1");
  await attach(app, cookie, noteId, "FLOOR-M2");

  const setOrdered = async (code: string, value: boolean) =>
    app.request(`/api/floor-notes/${noteId}/products/${code}/ordered`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });

  await setOrdered("FLOOR-M1", true);
  let [note] = await db.select().from(floorNotes).where(eq(floorNotes.id, noteId));
  expect(note?.ordered).toBe(false); // len 1 z 2 objednaných

  await setOrdered("FLOOR-M2", true);
  [note] = await db.select().from(floorNotes).where(eq(floorNotes.id, noteId));
  expect(note?.ordered).toBe(true); // všetky objednané → 🛒

  await setOrdered("FLOOR-M1", false);
  [note] = await db.select().from(floorNotes).where(eq(floorNotes.id, noteId));
  expect(note?.ordered).toBe(false); // symetricky späť
});

it("pripnutie novej položky do plne objednaného zápisu zhodí 🛒; odopnutie neobjednanej ho zdvihne", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "FLOOR-ATT-A", "Dod");
  await insertTestVariant(db, "FLOOR-ATT-B", "Dod");
  const noteId = await createNote(app, cookie, "Attach/detach prepočet");
  await attach(app, cookie, noteId, "FLOOR-ATT-A");

  const noteOrdered = async () => (await db.select().from(floorNotes).where(eq(floorNotes.id, noteId)))[0]?.ordered;

  // Objednaj jediný produkt → 🛒 true.
  await app.request(`/api/floor-notes/${noteId}/products/FLOOR-ATT-A/ordered`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ value: true }),
  });
  expect(await noteOrdered()).toBe(true);

  // Pripni druhý (neobjednaný) produkt → už NIE sú všetky objednané → 🛒 false.
  await attach(app, cookie, noteId, "FLOOR-ATT-B");
  expect(await noteOrdered()).toBe(false);

  // Odopni neobjednaný produkt → zostáva len objednaný → 🛒 späť true.
  const del = await app.request(`/api/floor-notes/${noteId}/products/FLOOR-ATT-B`, {
    method: "DELETE",
    headers: { cookie, "content-type": "application/json" },
  });
  expect(del.status).toBe(200);
  expect(await noteOrdered()).toBe(true);
});

it("vybavený (resolved) zápis → jeho predajňové riadky z Na objednanie zmiznú", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "FLOOR-RES", "Dod");
  const noteId = await createNote(app, cookie, "Bude vybavený");
  await attach(app, cookie, noteId, "FLOOR-RES");

  expect((await board(app, cookie)).some((g) => g.floorRows.some((r) => r.variantCode === "FLOOR-RES"))).toBe(true);

  await app.request(`/api/floor-notes/${noteId}/resolved`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ value: true }),
  });
  expect((await board(app, cookie)).some((g) => g.floorRows.some((r) => r.variantCode === "FLOOR-RES"))).toBe(false);
});

it("sekcia Riešiť predajňové riadky NEobsahuje", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "FLOOR-RIE", "Dod");
  const noteId = await createNote(app, cookie, "Nepatrí do Riešiť");
  await attach(app, cookie, noteId, "FLOOR-RIE");

  const riesit = await board(app, cookie, "/api/orders/riesit");
  expect(riesit.some((g) => g.floorRows.length > 0)).toBe(false);
});

it("predajňové riadky sa zobrazia aj keď nie sú nastavené žiadne otvorené stavy objednávok", async () => {
  const { app, cookie, db } = await boot("manazer");
  // `withCleanDb()` seeduje default otvorený stav — pre tento test ho ZMAŽ, aby
  // sme dokázali, že predajňové riadky sa zobrazia aj bez akýchkoľvek otvorených
  // stavov (nezávisia od nich, na rozdiel od riadkov objednávok).
  await db.delete(orderOpenStatuses);
  await insertTestVariant(db, "FLOOR-NOSTAT", "Dod");
  const noteId = await createNote(app, cookie, "Bez otvorených stavov");
  await attach(app, cookie, noteId, "FLOOR-NOSTAT");

  const groups = await board(app, cookie);
  expect(groups.find((g) => g.supplier === "Dod")?.floorRows.map((r) => r.variantCode)).toEqual(["FLOOR-NOSTAT"]);
});

it("hromadné 'označiť skupinu ako objednané' zahŕňa aj predajňové riadky a prepočíta 🛒", async () => {
  const { app, cookie, db, userId } = await boot("manazer");
  const { lineId } = await insertOrderLine(db, "Bulk Dod");
  await insertTestVariant(db, "FLOOR-BULK", "Bulk Dod");
  const noteId = await createNote(app, cookie, "Bulk zákazník");
  await attach(app, cookie, noteId, "FLOOR-BULK");

  const res = await app.request(`/api/suppliers/${encodeURIComponent("Bulk Dod")}/order-lines/ordered`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ordered: true }),
  });
  expect(res.status).toBe(200);
  // HTTP odpoveď nesie LEN lineCount (floor sa do nej nepridáva — spätná
  // kompatibilita existujúcich testov).
  expect(await res.json()).toEqual({ ok: true, ordered: true, lineCount: 1 });

  expect((await db.select().from(orderLines).where(eq(orderLines.id, lineId)))[0]?.ordered).toBe(true);
  expect((await db.select().from(floorNoteProducts).where(eq(floorNoteProducts.variantCode, "FLOOR-BULK")))[0]?.orderedAt).not.toBeNull();
  // Jediný produkt zápisu je teraz objednaný → 🛒.
  expect((await db.select().from(floorNotes).where(eq(floorNotes.id, noteId)))[0]?.ordered).toBe(true);

  const ev = (await db.select().from(auditEvents)).find((e) => e.action === "order_line.ordered.bulk_changed");
  expect(ev?.actorUserId).toBe(userId);
  expect(ev?.data).toMatchObject({ supplier: "Bulk Dod", ordered: true, lineCount: 1, floorRowCount: 1 });
});

it("hromadné označenie skupiny, ktorá má LEN predajňové riadky (žiadne objednávky), funguje", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "FLOOR-ONLY", "Only Dod");
  const noteId = await createNote(app, cookie, "Len predajňa");
  await attach(app, cookie, noteId, "FLOOR-ONLY");

  const res = await app.request(`/api/suppliers/${encodeURIComponent("Only Dod")}/order-lines/ordered`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ordered: true }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, ordered: true, lineCount: 0 });
  expect((await db.select().from(floorNoteProducts).where(eq(floorNoteProducts.variantCode, "FLOOR-ONLY")))[0]?.orderedAt).not.toBeNull();
  expect((await db.select().from(floorNotes).where(eq(floorNotes.id, noteId)))[0]?.ordered).toBe(true);
});

it("e-mail dodávateľovi predajňové riadky NEZAHŔŇA (existujúci e-mail tok nezmenený)", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertOrderLine(db, "Mail Dod", "MAIL-OL");
  await insertTestVariant(db, "MAIL-FLOOR", "Mail Dod");
  const noteId = await createNote(app, cookie, "Mailový zákazník");
  await attach(app, cookie, noteId, "MAIL-FLOOR");

  const content = await buildSupplierOrderMailContent(db, "Mail Dod");
  // Len order_line položka (MAIL-OL), NIKDY predajňový MAIL-FLOOR.
  expect(content.itemCount).toBe(1);
  expect(content.body).toContain("MAIL-OL");
  expect(content.body).not.toContain("MAIL-FLOOR");
});

it("rola citanie ani sef nesmie meniť príznak objednané predajňového riadku; cudzí Origin 403", async () => {
  for (const role of ["citanie", "sef"] as const) {
    const { app, cookie, db } = await boot(role);
    await insertTestVariant(db, `FLOOR-RBAC-${role}`, "Dod");
    // Zápis aj pripnutie potrebujú admin/manazer — pre readonly rolu ich vlož
    // priamo cez DB, aby sme izolovane overili gating SAMOTNEJ „ordered" trasy.
    const [note] = await db.insert(floorNotes).values({ text: "x", createdAt: new Date(), updatedAt: new Date() }).returning({ id: floorNotes.id });
    if (note === undefined) throw new Error("insert zápisu zlyhal");
    const noteId = note.id;
    await db.insert(floorNoteProducts).values({ floorNoteId: noteId, variantCode: `FLOOR-RBAC-${role}`, quantity: 1, createdAt: new Date() });
    const res = await app.request(`/api/floor-notes/${noteId}/products/FLOOR-RBAC-${role}/ordered`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ value: true }),
    });
    expect(res.status).toBe(403);
    await close?.();
    close = undefined;
  }

  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "FLOOR-ORIGIN", "Dod");
  const noteId = await createNote(app, cookie, "x");
  await attach(app, cookie, noteId, "FLOOR-ORIGIN");
  const cudzi = await app.request(`/api/floor-notes/${noteId}/products/FLOOR-ORIGIN/ordered`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: "https://utocnik.example", host: "forestshop.example" },
    body: JSON.stringify({ value: true }),
  });
  expect(cudzi.status).toBe(403);
});

it("neznáma položka zápisu vráti 404, neplatné telo 400", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "FLOOR-404", "Dod");
  const noteId = await createNote(app, cookie, "x");
  await attach(app, cookie, noteId, "FLOOR-404");

  const neznamy = await app.request(`/api/floor-notes/${noteId}/products/NEEXISTUJE/ordered`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ value: true }),
  });
  expect(neznamy.status).toBe(404);

  const neplatny = await app.request(`/api/floor-notes/${noteId}/products/FLOOR-404/ordered`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ value: "ano" }),
  });
  expect(neplatny.status).toBe(400);
});
