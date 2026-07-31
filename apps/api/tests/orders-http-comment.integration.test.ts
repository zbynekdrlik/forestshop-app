import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { auditEvents, orderLines, orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// Testy pre `PUT /api/orders/:id/comment` (issue 64 — manažérova voľná
// poznámka k CELEJ objednávke). Vlastný súbor, rovnaký dôvod ako
// `orders-http-state.integration.test.ts`/`orders-http-ordered.integration
// .test.ts` (eslint `max-lines: 400`, `.claude/rules/testing.md`).

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

// `poradie` robí variant/objednávku UNIKÁTNU pri viacerých volaniach v tom
// istom teste — rovnaký vzor ako `orders-http-state.integration.test.ts`.
let poradieVlozenia = 0;
async function vlozObjednavku(
  db: Awaited<ReturnType<typeof boot>>["db"],
  comment: string | null = null,
): Promise<{ orderId: string }> {
  poradieVlozenia += 1;
  const kod = `K-${String(poradieVlozenia)}`;
  await insertTestVariant(db, kod, "Dodávateľ Alfa");
  const [objednavka] = await db
    .insert(orders)
    .values({
      externalOrderId: `500${String(poradieVlozenia)}`,
      customerName: "Zákazník",
      comment,
      placedAt: new Date("2026-07-20T00:00:00Z"),
    })
    .returning();
  if (objednavka === undefined) throw new Error("insert objednávky zlyhal");
  await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: kod, quantity: 1 });
  return { orderId: objednavka.id };
}

it("manažér nastaví poznámku k objednávke, zápis sa uloží aj do auditu s tým, kto ho spravil", async () => {
  const { app, cookie, db, userId } = await boot("manazer");
  const { orderId } = await vlozObjednavku(db);

  const res = await app.request(`/api/orders/${orderId}/comment`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ comment: "Zavolať pred doručením" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, comment: "Zavolať pred doručením" });

  const [objednavka] = await db.select().from(orders).where(eq(orders.id, orderId));
  expect(objednavka?.comment).toBe("Zavolať pred doručením");

  const udalosti = await db.select().from(auditEvents);
  const udalost = udalosti.find((e) => e.action === "order.comment.changed");
  expect(udalost).toBeDefined();
  expect(udalost?.actorUserId).toBe(userId);
  expect(udalost?.entity).toBe("order");
  expect(udalost?.entityId).toBe(orderId);
  expect(udalost?.data).toMatchObject({ from: null, to: "Zavolať pred doručením" });
});

it("prázdna (orezaná) poznámka vymaže existujúcu hodnotu na null", async () => {
  const { app, cookie, db } = await boot("manazer");
  const { orderId } = await vlozObjednavku(db, "stará poznámka");

  const res = await app.request(`/api/orders/${orderId}/comment`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ comment: "   " }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, comment: null });

  const [objednavka] = await db.select().from(orders).where(eq(orders.id, orderId));
  expect(objednavka?.comment).toBeNull();
});

it("rola citanie nesmie zmeniť poznámku k objednávke", async () => {
  const { app, cookie, db } = await boot("citanie");
  const { orderId } = await vlozObjednavku(db);
  const res = await app.request(`/api/orders/${orderId}/comment`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ comment: "pokus" }),
  });
  expect(res.status).toBe(403);
});

it("rola sef tiež nesmie zmeniť poznámku k objednávke", async () => {
  const { app, cookie, db } = await boot("sef");
  const { orderId } = await vlozObjednavku(db);
  const res = await app.request(`/api/orders/${orderId}/comment`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ comment: "pokus" }),
  });
  expect(res.status).toBe(403);
});

it("neznáma objednávka vráti 404, príliš dlhá poznámka vráti 400", async () => {
  const { app, cookie, db } = await boot("manazer");
  await vlozObjednavku(db);

  const neznama = await app.request("/api/orders/11111111-1111-1111-1111-111111111111/comment", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ comment: "pokus" }),
  });
  expect(neznama.status).toBe(404);

  const { orderId } = await vlozObjednavku(db);
  const prilisDlha = await app.request(`/api/orders/${orderId}/comment`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ comment: "x".repeat(2001) }),
  });
  expect(prilisDlha.status).toBe(400);
});

it("zmena poznámky s cudzím Origin je odmietnutá (403), rovnaký pôvod prejde", async () => {
  const { app, cookie, db } = await boot("manazer");
  const { orderId } = await vlozObjednavku(db);

  const cudzi = await app.request(`/api/orders/${orderId}/comment`, {
    method: "PUT",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: "https://utocnik.example",
      host: "forestshop.example",
    },
    body: JSON.stringify({ comment: "pokus" }),
  });
  expect(cudzi.status).toBe(403);

  const rovnaky = await app.request(`/api/orders/${orderId}/comment`, {
    method: "PUT",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: "https://forestshop.example",
      host: "forestshop.example",
    },
    body: JSON.stringify({ comment: "pokus" }),
  });
  expect(rovnaky.status).toBe(200);
});
