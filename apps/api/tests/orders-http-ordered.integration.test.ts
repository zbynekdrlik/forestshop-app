import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { auditEvents, orderLines, orderOpenStatuses, orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { NEZNAMY_DODAVATEL } from "../src/modules/orders/queries.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// Testy pre `POST /api/orders/lines/:lineId/ordered` a
// `PUT /api/suppliers/:supplier/order-lines/ordered` (issue 60 — nezávislý
// príznak "objednané u dodávateľa" + hromadné označenie celej skupiny).
// Vlastný súbor, rovnaký dôvod ako `orders-http-state.integration.test.ts`
// (eslint `max-lines: 400`, `.claude/rules/testing.md`).

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
    .values({
      email: "manazer@forestshop.sk",
      passwordHash: await hashPassword(HESLO),
      displayName: "Manažér",
      role,
    })
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

let poradieVlozenia = 0;
async function vlozRiadok(
  db: Awaited<ReturnType<typeof boot>>["db"],
  supplier: string | null = "Dodávateľ Alfa",
): Promise<{ orderId: string; lineId: string }> {
  poradieVlozenia += 1;
  const kod = `B-${String(poradieVlozenia)}`;
  await insertTestVariant(db, kod, supplier);
  const [objednavka] = await db
    .insert(orders)
    .values({
      externalOrderId: `500${String(poradieVlozenia)}`,
      customerName: "Zákazník",
      placedAt: new Date("2026-07-20T00:00:00Z"),
    })
    .returning();
  if (objednavka === undefined) throw new Error("insert objednávky zlyhal");
  const [riadok] = await db
    .insert(orderLines)
    .values({ orderId: objednavka.id, variantCode: kod, quantity: 1 })
    .returning();
  if (riadok === undefined) throw new Error("insert riadku zlyhal");
  return { orderId: objednavka.id, lineId: riadok.id };
}

it("manažér odškrtne riadok ako objednaný, zápis sa uloží aj do auditu", async () => {
  const { app, cookie, db, userId } = await boot("manazer");
  const { orderId, lineId } = await vlozRiadok(db);

  const res = await app.request(`/api/orders/lines/${lineId}/ordered`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ordered: true }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, ordered: true });

  const [riadok] = await db.select().from(orderLines).where(eq(orderLines.id, lineId));
  expect(riadok?.ordered).toBe(true);

  const udalosti = await db.select().from(auditEvents);
  const udalost = udalosti.find((e) => e.action === "order_line.ordered.changed");
  expect(udalost).toBeDefined();
  expect(udalost?.actorUserId).toBe(userId);
  expect(udalost?.entity).toBe("order_line");
  expect(udalost?.entityId).toBe(lineId);
  expect(udalost?.data).toMatchObject({ orderId, from: false, to: true });

  // Odškrtnutie späť funguje rovnako (opačná hodnota).
  const zrusenie = await app.request(`/api/orders/lines/${lineId}/ordered`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ordered: false }),
  });
  expect(zrusenie.status).toBe(200);
  const [riadokPoZruseni] = await db.select().from(orderLines).where(eq(orderLines.id, lineId));
  expect(riadokPoZruseni?.ordered).toBe(false);
});

// Rola citanie a rola sef, KAŽDÁ vo VLASTNOM teste (vlastné `boot()` volanie,
// vlastné `afterEach` uzavretie) — dva `boot()`-štýl helpery volané v jednom
// teste (bez uzavretia prvého) by si prepísali `withCleanDb()`'s advisory
// zámok a druhé volanie by sa navždy zaseklo (`.claude/rules/testing.md`).
it("rola citanie nesmie zmeniť príznak objednané", async () => {
  const { app, cookie, db } = await boot("citanie");
  const { lineId } = await vlozRiadok(db);
  const res = await app.request(`/api/orders/lines/${lineId}/ordered`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ordered: true }),
  });
  expect(res.status).toBe(403);
});

it("rola sef nesmie zmeniť príznak objednané", async () => {
  const { app, cookie, db } = await boot("sef");
  const { lineId } = await vlozRiadok(db);
  const res = await app.request(`/api/orders/lines/${lineId}/ordered`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ordered: true }),
  });
  expect(res.status).toBe(403);
});

it("neznámy riadok vráti 404, neplatná hodnota vráti 400", async () => {
  const { app, cookie, db } = await boot("manazer");
  await vlozRiadok(db);

  const neznamy = await app.request("/api/orders/lines/11111111-1111-1111-1111-111111111111/ordered", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ordered: true }),
  });
  expect(neznamy.status).toBe(404);

  const { lineId } = await vlozRiadok(db);
  const neplatny = await app.request(`/api/orders/lines/${lineId}/ordered`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ordered: "ano" }),
  });
  expect(neplatny.status).toBe(400);
});

it("manažér označí celú skupinu dodávateľa ako objednané naraz, JEDEN agregovaný audit záznam", async () => {
  const { app, cookie, db, userId } = await boot("manazer");
  await db.insert(orderOpenStatuses).values({ statusName: "Vybavuje sa" }).onConflictDoNothing();
  const prvy = await vlozRiadok(db, "Dodávateľ Bulk");
  const druhy = await vlozRiadok(db, "Dodávateľ Bulk");
  // Iný dodávateľ v tom istom behu — bulk naň nesmie siahnuť.
  const cudzi = await vlozRiadok(db, "Iný dodávateľ");

  const res = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ Bulk")}/order-lines/ordered`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ordered: true }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, ordered: true, lineCount: 2 });

  const riadky = await db.select().from(orderLines);
  const stavPrveho = riadky.find((r) => r.id === prvy.lineId);
  const stavDruheho = riadky.find((r) => r.id === druhy.lineId);
  const stavCudzieho = riadky.find((r) => r.id === cudzi.lineId);
  expect(stavPrveho?.ordered).toBe(true);
  expect(stavDruheho?.ordered).toBe(true);
  expect(stavCudzieho?.ordered).toBe(false);

  const udalosti = await db.select().from(auditEvents);
  const bulkUdalosti = udalosti.filter((e) => e.action === "order_line.ordered.bulk_changed");
  expect(bulkUdalosti).toHaveLength(1);
  expect(bulkUdalosti[0]?.actorUserId).toBe(userId);
  expect(bulkUdalosti[0]?.entityId).toBe("Dodávateľ Bulk");
  expect(bulkUdalosti[0]?.data).toMatchObject({
    supplier: "Dodávateľ Bulk",
    ordered: true,
    lineCount: 2,
    lineIds: expect.arrayContaining([prvy.lineId, druhy.lineId]) as unknown,
  });

  // Opačným smerom — zrušenie celej skupiny naraz.
  const zrusenie = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ Bulk")}/order-lines/ordered`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ordered: false }),
  });
  expect(zrusenie.status).toBe(200);
  expect(await zrusenie.json()).toEqual({ ok: true, ordered: false, lineCount: 2 });
});

it("hromadné označenie zástupnej skupiny '(bez dodávateľa)' zasiahne len riadky bez dodávateľa", async () => {
  const { app, cookie, db } = await boot("manazer");
  await db.insert(orderOpenStatuses).values({ statusName: "Vybavuje sa" }).onConflictDoNothing();
  const bezDodavatela = await vlozRiadok(db, null);
  const sDodavatelom = await vlozRiadok(db, "Dodávateľ Iný");

  const res = await app.request(`/api/suppliers/${encodeURIComponent(NEZNAMY_DODAVATEL)}/order-lines/ordered`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ordered: true }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, ordered: true, lineCount: 1 });

  const riadky = await db.select().from(orderLines);
  expect(riadky.find((r) => r.id === bezDodavatela.lineId)?.ordered).toBe(true);
  expect(riadky.find((r) => r.id === sDodavatelom.lineId)?.ordered).toBe(false);
});

it("hromadné označenie na dodávateľa bez otvorených riadkov je neškodný no-op (0, žiadny audit)", async () => {
  const { app, cookie, db } = await boot("manazer");
  await db.insert(orderOpenStatuses).values({ statusName: "Vybavuje sa" }).onConflictDoNothing();

  const res = await app.request(`/api/suppliers/${encodeURIComponent("Neexistujuci dodavatel")}/order-lines/ordered`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ordered: true }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, ordered: true, lineCount: 0 });

  const udalosti = await db.select().from(auditEvents);
  expect(udalosti.some((e) => e.action === "order_line.ordered.bulk_changed")).toBe(false);
});

it("rola citanie nesmie hromadne meniť príznak objednané", async () => {
  const { app, cookie, db } = await boot("citanie");
  await db.insert(orderOpenStatuses).values({ statusName: "Vybavuje sa" }).onConflictDoNothing();
  await vlozRiadok(db, "Dodávateľ X");

  const res = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ X")}/order-lines/ordered`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ordered: true }),
  });
  expect(res.status).toBe(403);
});
