import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { auditEvents, orderLines, orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// Testy pre `POST /api/orders/lines/:lineId/state` (#25 — zmena stavu riadku
// objednávky + audit). Vydelené z `orders-http.integration.test.ts` (ktorý
// pokrýva čítacie trasy + spustenie importu), aby ani jeden zo súborov
// nenarástol cez limit 400 riadkov (eslint `max-lines`) — rovnaký vzor ako
// `catalog-http.integration.test.ts` / `catalog-http-ingest.integration.test.ts`.

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
// istom teste — `insertTestVariant` vkladá `product`/`variant` s daným kódom
// ako primárnym kľúčom, druhé volanie s tým istým kódom by zhodilo unique
// constraint.
let poradieVlozenia = 0;
async function vlozRiadok(db: Awaited<ReturnType<typeof boot>>["db"]): Promise<{ orderId: string; lineId: string }> {
  poradieVlozenia += 1;
  const kod = `A-${String(poradieVlozenia)}`;
  await insertTestVariant(db, kod, "Dodávateľ Alfa");
  const [objednavka] = await db
    .insert(orders)
    .values({
      externalOrderId: `400${String(poradieVlozenia)}`,
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

it("manažér zmení stav riadku objednávky, zápis sa uloží aj do auditu s tým, kto ho spravil", async () => {
  const { app, cookie, db, userId } = await boot("manazer");
  const { orderId, lineId } = await vlozRiadok(db);

  const res = await app.request(`/api/orders/lines/${lineId}/state`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ state: "skladom" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, state: "skladom" });

  const [riadok] = await db.select().from(orderLines).where(eq(orderLines.id, lineId));
  expect(riadok?.state).toBe("skladom");

  const udalosti = await db.select().from(auditEvents);
  const udalost = udalosti.find((e) => e.action === "order_line.state.changed");
  expect(udalost).toBeDefined();
  expect(udalost?.actorUserId).toBe(userId);
  expect(udalost?.entity).toBe("order_line");
  expect(udalost?.entityId).toBe(lineId);
  expect(udalost?.data).toMatchObject({ orderId, from: "objednane", to: "skladom" });
});

// issue 493: šiesty stav „Objednané" (interná hodnota `objednane_stav`, NIE
// `objednane`) — over, že route ho prijme (Zod `z.enum(orderLineState
// .enumValues)`), zapíše do DB a do auditu s korektným `from`/`to`, a že sa dá
// z neho aj prepnúť späť (round-trip novej enum hodnoty end-to-end).
it("manažér nastaví stav Objednané (objednane_stav) a potom prepne späť — round-trip novej enum hodnoty", async () => {
  const { app, cookie, db } = await boot("manazer");
  const { orderId, lineId } = await vlozRiadok(db);

  const nastav = await app.request(`/api/orders/lines/${lineId}/state`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ state: "objednane_stav" }),
  });
  expect(nastav.status).toBe(200);
  expect(await nastav.json()).toEqual({ ok: true, state: "objednane_stav" });

  const [poNastaveni] = await db.select().from(orderLines).where(eq(orderLines.id, lineId));
  expect(poNastaveni?.state).toBe("objednane_stav");

  const prepni = await app.request(`/api/orders/lines/${lineId}/state`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ state: "skladom" }),
  });
  expect(prepni.status).toBe(200);

  const [poPrepnuti] = await db.select().from(orderLines).where(eq(orderLines.id, lineId));
  expect(poPrepnuti?.state).toBe("skladom");

  const udalosti = await db.select().from(auditEvents);
  const zmeny = udalosti.filter((e) => e.action === "order_line.state.changed");
  expect(zmeny).toHaveLength(2);
  // Order-independent (dve HTTP requesty môžu mať rovnaký `at` v tej istej ms):
  // over KAŽDÚ zmenu podľa jej `to` hodnoty, nie podľa poradia v poli.
  const naObjednane = zmeny.find((e) => (e.data as { to?: string }).to === "objednane_stav");
  const naSkladom = zmeny.find((e) => (e.data as { to?: string }).to === "skladom");
  expect(naObjednane?.data).toMatchObject({ orderId, from: "objednane", to: "objednane_stav" });
  expect(naSkladom?.data).toMatchObject({ orderId, from: "objednane_stav", to: "skladom" });
});

it("rola citanie nesmie zmeniť stav riadku objednávky", async () => {
  const { app, cookie, db } = await boot("citanie");
  const { lineId } = await vlozRiadok(db);
  const res = await app.request(`/api/orders/lines/${lineId}/state`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ state: "skladom" }),
  });
  expect(res.status).toBe(403);
});

it("rola sef tiež nesmie zmeniť stav riadku objednávky", async () => {
  const { app, cookie, db } = await boot("sef");
  const { lineId } = await vlozRiadok(db);
  const res = await app.request(`/api/orders/lines/${lineId}/state`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ state: "skladom" }),
  });
  expect(res.status).toBe(403);
});

it("neznámy riadok vráti 404, neplatná hodnota stavu vráti 400", async () => {
  const { app, cookie, db } = await boot("manazer");
  await vlozRiadok(db);

  const neznamy = await app.request("/api/orders/lines/11111111-1111-1111-1111-111111111111/state", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ state: "skladom" }),
  });
  expect(neznamy.status).toBe(404);

  const { lineId } = await vlozRiadok(db);
  const neplatny = await app.request(`/api/orders/lines/${lineId}/state`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ state: "zrusene" }),
  });
  expect(neplatny.status).toBe(400);
});

it("zmena stavu s cudzím Origin je odmietnutá (403), rovnaký pôvod prejde", async () => {
  const { app, cookie, db } = await boot("manazer");
  const { lineId } = await vlozRiadok(db);

  const cudzi = await app.request(`/api/orders/lines/${lineId}/state`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: "https://utocnik.example",
      host: "forestshop.example",
    },
    body: JSON.stringify({ state: "skladom" }),
  });
  expect(cudzi.status).toBe(403);

  const rovnaky = await app.request(`/api/orders/lines/${lineId}/state`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: "https://forestshop.example",
      host: "forestshop.example",
    },
    body: JSON.stringify({ state: "skladom" }),
  });
  expect(rovnaky.status).toBe(200);
});
