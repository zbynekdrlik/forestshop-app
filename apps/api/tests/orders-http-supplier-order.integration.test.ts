import { expect, it } from "vitest";
import { afterEach } from "vitest";
import { orderLines, orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 152: dodávateľské skupiny (aj chipy hore, aj sekcie na stránke) sa
// teraz zoraďujú podľa NAJNOVŠEJ objednávky (najčerstvejšia prvá), nie
// abecedne — priamy náprotivok starej appky (`app.js:2470-2476`, `2671-
// 2672`). VLASTNÝ súbor, rovnaký dôvod ako `orders-http-annotations
// .integration.test.ts`/`orders-http-comment.integration.test.ts`: `orders-
// http.integration.test.ts` je už na hranici eslint `max-lines: 400`
// (`.claude/rules/testing.md`).

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
  return { app, cookie, db: ctx.db };
}

it("skupiny dodávateľov sú zoradené podľa NAJNOVŠEJ objednávky (najčerstvejšia prvá), nie abecedne", async () => {
  const { app, cookie, db } = await boot("citanie");
  // Zámerne abecedne OPAČNÉ poradie, než aké má vzniknúť podľa dátumu —
  // "Alfa" (najstaršia objednávka) by abecedne bola prvá, ale podľa dátumu
  // musí skončiť POSLEDNÁ; "Zeta" (najnovšia) musí skončiť PRVÁ.
  await insertTestVariant(db, "SUP-ALFA", "Dodávateľ Alfa");
  await insertTestVariant(db, "SUP-STRED", "Dodávateľ Stred");
  await insertTestVariant(db, "SUP-ZETA", "Dodávateľ Zeta");

  const [najstarsia] = await db
    .insert(orders)
    .values({ externalOrderId: "9001", customerName: "Zákazník 1", placedAt: new Date("2026-07-01T00:00:00Z") })
    .returning();
  const [stredna] = await db
    .insert(orders)
    .values({ externalOrderId: "9002", customerName: "Zákazník 2", placedAt: new Date("2026-07-15T00:00:00Z") })
    .returning();
  const [najnovsia] = await db
    .insert(orders)
    .values({ externalOrderId: "9003", customerName: "Zákazník 3", placedAt: new Date("2026-07-20T00:00:00Z") })
    .returning();
  if (najstarsia === undefined || stredna === undefined || najnovsia === undefined) throw new Error("insert zlyhal");

  await db.insert(orderLines).values([
    { orderId: najstarsia.id, variantCode: "SUP-ALFA", quantity: 1 },
    { orderId: stredna.id, variantCode: "SUP-STRED", quantity: 1 },
    { orderId: najnovsia.id, variantCode: "SUP-ZETA", quantity: 1 },
  ]);

  const res = await app.request("/api/orders/open", { headers: { cookie } });
  expect(res.status).toBe(200);
  const telo = (await res.json()) as { suppliers: { supplier: string }[] };

  expect(telo.suppliers.map((s) => s.supplier)).toEqual(["Dodávateľ Zeta", "Dodávateľ Stred", "Dodávateľ Alfa"]);
});

// Pri REMÍZE (rovnaký čas najnovšej objednávky oboch skupín) sa rozhoduje
// abecedne — priamy náprotivok existujúcej `supplier-key.test.ts`'s "remíza
// sa rozhodne abecedne" pravidla pre pravopis v rámci JEDNEJ skupiny,
// tentokrát na úrovni PORADIA SAMOTNÝCH SKUPÍN.
it("pri zhodnom čase najnovšej objednávky sa poradie skupín rozhodne abecedne", async () => {
  const { app, cookie, db } = await boot("citanie");
  await insertTestVariant(db, "SUP-BETA", "Dodávateľ Beta");
  await insertTestVariant(db, "SUP-CENTRUM", "Dodávateľ Centrum");

  const [zdielanaObjednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "9010", customerName: "Zákazník", placedAt: new Date("2026-07-18T00:00:00Z") })
    .returning();
  if (zdielanaObjednavka === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values([
    { orderId: zdielanaObjednavka.id, variantCode: "SUP-BETA", quantity: 1 },
    { orderId: zdielanaObjednavka.id, variantCode: "SUP-CENTRUM", quantity: 1 },
  ]);

  const res = await app.request("/api/orders/open", { headers: { cookie } });
  const telo = (await res.json()) as { suppliers: { supplier: string }[] };
  expect(telo.suppliers.map((s) => s.supplier)).toEqual(["Dodávateľ Beta", "Dodávateľ Centrum"]);
});

// "(bez dodávateľa)" ostáva VŽDY posledný, aj keď má ONA NAJNOVŠIU
// objednávku zo všetkých skupín — akceptačná podmienka to žiada výslovne.
it("'(bez dodávateľa)' ostáva vždy posledný, aj keď má najnovšiu objednávku spomedzi všetkých skupín", async () => {
  const { app, cookie, db } = await boot("citanie");
  await insertTestVariant(db, "SUP-STARY", "Dodávateľ Starý");
  await insertTestVariant(db, "SUP-BEZ", null);

  const [starsiaObjednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "9020", customerName: "Zákazník 1", placedAt: new Date("2026-07-01T00:00:00Z") })
    .returning();
  const [najnovsiaObjednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "9021", customerName: "Zákazník 2", placedAt: new Date("2026-07-25T00:00:00Z") })
    .returning();
  if (starsiaObjednavka === undefined || najnovsiaObjednavka === undefined) throw new Error("insert zlyhal");

  await db.insert(orderLines).values([
    { orderId: starsiaObjednavka.id, variantCode: "SUP-STARY", quantity: 1 },
    // Najnovšia objednávka zo VŠETKÝCH ide práve na riadok BEZ dodávateľa.
    { orderId: najnovsiaObjednavka.id, variantCode: "SUP-BEZ", quantity: 1 },
  ]);

  const res = await app.request("/api/orders/open", { headers: { cookie } });
  const telo = (await res.json()) as { suppliers: { supplier: string }[] };
  expect(telo.suppliers.map((s) => s.supplier)).toEqual(["Dodávateľ Starý", "(bez dodávateľa)"]);
});
