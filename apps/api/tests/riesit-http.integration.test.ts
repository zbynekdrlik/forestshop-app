import { and, eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { auditEvents, orderLines, orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 476: sekcia „Riešiť" (piaty exkluzívny stav `riesit`) — `GET /api/
// orders/riesit` (zoznam zúžený na stav riesit), `GET /api/orders/riesit/
// count` (menu odznak) a `POST /api/orders/riesit/by-code` (rýchle pole:
// číslo objednávky → stav riesit na všetkých riadkoch). `withCleanDb()`
// reseeduje default otvorený stav „Vybavuje sa", takže seedované objednávky
// sú OTVORENÉ, ak sa `statusName` výslovne nezmení.

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

let poradie = 0;
// Vloží objednávku so `pocetRiadkov` riadkami (predvolený stav `objednane`).
// `statusName` nepovinné — predvolene default otvorený „Vybavuje sa".
async function vlozObjednavku(
  db: Awaited<ReturnType<typeof boot>>["db"],
  pocetRiadkov: number,
  statusName?: string,
): Promise<{ orderId: string; code: string; lineIds: string[] }> {
  poradie += 1;
  const code = `7${String(poradie).padStart(3, "0")}`;
  const [objednavka] = await db
    .insert(orders)
    .values({
      externalOrderId: code,
      customerName: "Zákazník",
      placedAt: new Date("2026-08-01T00:00:00Z"),
      ...(statusName === undefined ? {} : { statusName }),
    })
    .returning();
  if (objednavka === undefined) throw new Error("insert objednávky zlyhal");
  const lineIds: string[] = [];
  for (let i = 0; i < pocetRiadkov; i += 1) {
    poradie += 1;
    const kod = `R-${String(poradie)}`;
    await insertTestVariant(db, kod, "Dodávateľ Riešiť");
    const [riadok] = await db
      .insert(orderLines)
      .values({ orderId: objednavka.id, variantCode: kod, quantity: 1 })
      .returning();
    if (riadok === undefined) throw new Error("insert riadku zlyhal");
    lineIds.push(riadok.id);
  }
  return { orderId: objednavka.id, code, lineIds };
}

async function setState(app: ReturnType<typeof createApp>, cookie: string, lineId: string, state: string): Promise<Response> {
  return app.request(`/api/orders/lines/${lineId}/state`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ state }),
  });
}

// --- GET /api/orders/riesit ---

it("GET /api/orders/riesit vráti LEN riadky v stave riesit, zoskupené po dodávateľoch", async () => {
  const { app, cookie, db } = await boot("manazer");
  const a = await vlozObjednavku(db, 1); // ostane objednane
  const b = await vlozObjednavku(db, 1); // dáme do riesit

  // existujúca stavová trasa akceptuje `riesit` (zod je odvodený z enumu)
  const setRes = await setState(app, cookie, b.lineIds[0] ?? "", "riesit");
  expect(setRes.status).toBe(200);

  const res = await app.request("/api/orders/riesit", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { suppliers: readonly { lines: readonly { lineId: string; state: string }[] }[] };
  const vsetkyRiadky = body.suppliers.flatMap((s) => s.lines);
  expect(vsetkyRiadky.map((l) => l.lineId)).toEqual([b.lineIds[0]]);
  expect(vsetkyRiadky.every((l) => l.state === "riesit")).toBe(true);
  // riadok objednávky `a` (stav objednane) sa v sekcii Riešiť NEobjaví
  expect(vsetkyRiadky.some((l) => l.lineId === a.lineIds[0])).toBe(false);
});

it("GET /api/orders/riesit bez prihlásenia vráti 401", async () => {
  const { app } = await boot("manazer");
  const res = await app.request("/api/orders/riesit");
  expect(res.status).toBe(401);
});

// --- GET /api/orders/riesit/count ---

it("GET /api/orders/riesit/count počíta LEN otvorené riadky v stave riesit", async () => {
  const { app, cookie, db } = await boot("manazer");
  const a = await vlozObjednavku(db, 2);
  await vlozObjednavku(db, 1); // ostane objednane, do počtu nevstúpi

  const c0 = await app.request("/api/orders/riesit/count", { headers: { cookie } });
  expect((await c0.json()) as { count: number }).toEqual({ count: 0 });

  await setState(app, cookie, a.lineIds[0] ?? "", "riesit");
  await setState(app, cookie, a.lineIds[1] ?? "", "riesit");

  const c2 = await app.request("/api/orders/riesit/count", { headers: { cookie } });
  expect((await c2.json()) as { count: number }).toEqual({ count: 2 });
});

it("GET /api/orders/riesit/count NEpočíta riadky zatvorenej objednávky", async () => {
  const { app, cookie, db } = await boot("manazer");
  // objednávka v NEotvorenom Shoptet stave — jej riadky sa nikde neukážu
  const zatvorena = await vlozObjednavku(db, 1, "Vybavená");
  // stav riadku nastavíme priamo v DB (trasa mení stav bez ohľadu na open-status)
  await db.update(orderLines).set({ state: "riesit" }).where(eq(orderLines.id, zatvorena.lineIds[0] ?? ""));

  const res = await app.request("/api/orders/riesit/count", { headers: { cookie } });
  expect((await res.json()) as { count: number }).toEqual({ count: 0 });
});

// --- POST /api/orders/riesit/by-code ---

it("POST /api/orders/riesit/by-code označí VŠETKY riadky otvorenej objednávky stavom riesit + audit", async () => {
  const { app, cookie, db, userId } = await boot("manazer");
  const obj = await vlozObjednavku(db, 3);

  const res = await app.request("/api/orders/riesit/by-code", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ code: obj.code }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()) as { ok: boolean; lineCount: number }).toEqual({ ok: true, lineCount: 3 });

  const riadky = await db.select({ state: orderLines.state }).from(orderLines).where(eq(orderLines.orderId, obj.orderId));
  expect(riadky.every((r) => r.state === "riesit")).toBe(true);

  // audit: jeden `order_line.state.changed` na riadok, s tým, kto ho spravil
  const audit = await db
    .select({ entityId: auditEvents.entityId })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, "order_line.state.changed"), eq(auditEvents.actorUserId, userId)));
  expect(audit.length).toBe(3);

  // a hneď sa zobrazia v sekcii Riešiť
  const list = await app.request("/api/orders/riesit", { headers: { cookie } });
  const body = (await list.json()) as { suppliers: readonly { lines: readonly unknown[] }[] };
  expect(body.suppliers.flatMap((s) => s.lines).length).toBe(3);
});

it("POST /api/orders/riesit/by-code: keď je objednávka UŽ celá v riesit, vráti lineCount 0 (žiadny zbytočný zápis/audit)", async () => {
  const { app, cookie, db, userId } = await boot("manazer");
  const obj = await vlozObjednavku(db, 2);
  // prvým volaním všetko označíme
  const prve = await app.request("/api/orders/riesit/by-code", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ code: obj.code }),
  });
  expect((await prve.json()) as { lineCount: number }).toEqual({ ok: true, lineCount: 2 });

  // druhé volanie už nič nemení → lineCount 0
  const druhe = await app.request("/api/orders/riesit/by-code", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ code: obj.code }),
  });
  expect(druhe.status).toBe(200);
  expect((await druhe.json()) as { lineCount: number }).toEqual({ ok: true, lineCount: 0 });

  // audit z prvého behu ostáva 2 (druhý beh nepridal žiadny)
  const audit = await db
    .select({ entityId: auditEvents.entityId })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, "order_line.state.changed"), eq(auditEvents.actorUserId, userId)));
  expect(audit.length).toBe(2);
});

it("POST /api/orders/riesit/by-code: neznáme číslo vráti 200 {ok:false} so zrozumiteľnou hláškou (NIE 4xx — konzola)", async () => {
  const { app, cookie } = await boot("manazer");
  const res = await app.request("/api/orders/riesit/by-code", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ code: "999999" }),
  });
  // 200, nie 4xx — bežný používateľský omyl nesmie logovať konzolovú chybu
  // (Chromium loguje 4xx; `.claude/rules/testing.md`), naživo overené na prode.
  expect(res.status).toBe(200);
  const telo = (await res.json()) as { ok: boolean; error?: string };
  expect(telo.ok).toBe(false);
  expect(telo.error).toContain("nenašla");
});

it("POST /api/orders/riesit/by-code: zatvorená objednávka vráti 200 {ok:false} (nie je otvorená, NIE 4xx)", async () => {
  const { app, cookie, db } = await boot("manazer");
  const zatvorena = await vlozObjednavku(db, 1, "Vybavená");

  const res = await app.request("/api/orders/riesit/by-code", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ code: zatvorena.code }),
  });
  expect(res.status).toBe(200);
  const telo = (await res.json()) as { ok: boolean; error?: string };
  expect(telo.ok).toBe(false);
  expect(telo.error).toContain("nie je otvorená");

  // stav riadku sa nezmenil
  const [r] = await db.select({ state: orderLines.state }).from(orderLines).where(eq(orderLines.id, zatvorena.lineIds[0] ?? ""));
  expect(r?.state).toBe("objednane");
});

it("POST /api/orders/riesit/by-code: rola citanie dostane 403 (rovnaká brána ako zmena stavu)", async () => {
  const { app, cookie, db } = await boot("citanie");
  const obj = await vlozObjednavku(db, 1);
  const res = await app.request("/api/orders/riesit/by-code", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ code: obj.code }),
  });
  expect(res.status).toBe(403);
});
