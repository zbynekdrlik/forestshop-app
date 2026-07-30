import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { auditEvents, orderLines, orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import type { OrdersIngestResult, RunOrdersIngest } from "../src/modules/orders/ingest.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

const HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot(role: UserRole, runOrdersIngest?: RunOrdersIngest) {
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

  const app = createApp(ctx.db, {
    cookieSecure: false,
    ...(runOrdersIngest === undefined ? {} : { runOrdersIngest }),
  });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db, userId: pouzivatel.id };
}

it("bez prihlásenia vráti 401 na všetkých štyroch trasách objednávok", async () => {
  const { app } = await boot("manazer");
  const trasy: { readonly path: string; readonly method: "GET" | "POST" }[] = [
    { path: "/api/orders/open", method: "GET" },
    { path: "/api/orders/11111111-1111-1111-1111-111111111111", method: "GET" },
    { path: "/api/orders/ingest", method: "POST" },
    { path: "/api/orders/lines/11111111-1111-1111-1111-111111111111/state", method: "POST" },
  ];
  for (const trasa of trasy) {
    const res = await app.request(trasa.path, { method: trasa.method });
    expect(res.status).toBe(401);
  }
});

it("vráti otvorené objednávky zoskupené podľa dodávateľa, riadky zostupne podľa dátumu objednávky", async () => {
  const { app, cookie, db } = await boot("citanie"); // čítanie smie vidieť otvorené objednávky
  await insertTestVariant(db, "A-1", "Dodávateľ Alfa");
  await insertTestVariant(db, "B-1", "Dodávateľ Beta");

  const [staraObjednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "1001", customerName: "Zákazník 1", placedAt: new Date("2026-07-01T00:00:00Z") })
    .returning();
  const [novaObjednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "1002", customerName: "Zákazník 2", placedAt: new Date("2026-07-15T00:00:00Z") })
    .returning();
  if (staraObjednavka === undefined || novaObjednavka === undefined) throw new Error("insert zlyhal");

  // Jedna objednávka (1002) obsahuje položky OD DVOCH dodávateľov — zoskupenie
  // preto beží na úrovni RIADKA, nie objednávky.
  await db.insert(orderLines).values([
    { orderId: staraObjednavka.id, variantCode: "A-1", quantity: 2 },
    { orderId: novaObjednavka.id, variantCode: "A-1", quantity: 1 },
    { orderId: novaObjednavka.id, variantCode: "B-1", quantity: 5 },
  ]);

  const res = await app.request("/api/orders/open", { headers: { cookie } });
  expect(res.status).toBe(200);
  const telo = (await res.json()) as {
    suppliers: { supplier: string; lines: { externalOrderId: string; variantCode: string; quantity: number }[] }[];
  };

  expect(telo.suppliers.map((s) => s.supplier)).toEqual(["Dodávateľ Alfa", "Dodávateľ Beta"]);

  const alfa = telo.suppliers.find((s) => s.supplier === "Dodávateľ Alfa");
  // Novšia objednávka (1002) prvá — zostupné triedenie podľa placedAt.
  expect(alfa?.lines.map((l) => l.externalOrderId)).toEqual(["1002", "1001"]);
  expect(alfa?.lines.map((l) => l.quantity)).toEqual([1, 2]);

  const beta = telo.suppliers.find((s) => s.supplier === "Dodávateľ Beta");
  expect(beta?.lines).toHaveLength(1);
  expect(beta?.lines[0]).toMatchObject({ externalOrderId: "1002", variantCode: "B-1", quantity: 5 });
});

// issue 67: odkaz na tovar u dodávateľa (extrahovaný z `internalNote`) a kód
// dodávateľa (`externalCode`) sa objavia v `/api/orders/open`, v troch
// tvaroch, aké export skutočne obsahuje (holý odkaz, odkaz s popisom, žiadny
// odkaz — len poznámka).
it("vráti odkaz na dodávateľa a kód dodávateľa pri riadku, vo všetkých troch tvaroch internalNote", async () => {
  const { app, cookie, db } = await boot("citanie");
  await insertTestVariant(db, "HOLY-URL", "Dodávateľ Holý", {
    internalNote: "https://www.huntingshop.eu/fairfax-fz-mikina",
    externalCode: "OB832",
  });
  await insertTestVariant(db, "S-POPISOM", "Dodávateľ Popis", {
    internalNote: "Dodávateľ: Trigona - https://trigona.sk/smith-s/polovnicke/c199",
    externalCode: "TRG-1",
  });
  await insertTestVariant(db, "BEZ-URL", "Dodávateľ Bez odkazu", { internalNote: "Soxland" });

  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "4001", customerName: "Zákazník", placedAt: new Date("2026-07-20T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values([
    { orderId: objednavka.id, variantCode: "HOLY-URL", quantity: 1 },
    { orderId: objednavka.id, variantCode: "S-POPISOM", quantity: 1 },
    { orderId: objednavka.id, variantCode: "BEZ-URL", quantity: 1 },
  ]);

  const res = await app.request("/api/orders/open", { headers: { cookie } });
  const telo = (await res.json()) as {
    suppliers: {
      supplier: string;
      lines: { variantCode: string; supplierUrl: string | null; supplierNote: string | null; externalCode: string | null }[];
    }[];
  };

  const linePre = (supplier: string) => telo.suppliers.find((s) => s.supplier === supplier)?.lines[0];

  expect(linePre("Dodávateľ Holý")).toMatchObject({
    supplierUrl: "https://www.huntingshop.eu/fairfax-fz-mikina",
    externalCode: "OB832",
  });
  expect(linePre("Dodávateľ Popis")).toMatchObject({
    supplierUrl: "https://trigona.sk/smith-s/polovnicke/c199",
    supplierNote: "Dodávateľ: Trigona - https://trigona.sk/smith-s/polovnicke/c199",
    externalCode: "TRG-1",
  });
  expect(linePre("Dodávateľ Bez odkazu")).toMatchObject({
    supplierUrl: null,
    supplierNote: "Soxland",
    externalCode: null,
  });
});

// Review finding: `product.supplier` je nepovinný stĺpec (Shoptet export
// niekedy nesie prázdnu hodnotu, `map-row.ts`'s `textOrNull`) — bez tohto
// testu by regresia zlomeného `?? NEZNAMY_DODAVATEL` fallbacku (napr.
// omylom pridané non-null tvrdenie) prešla ticho.
it("riadok bez dodávateľa (product.supplier je null) sa zoskupí pod čitateľný zástupný kľúč, nielen na 'null'", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "N-1", null);

  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "3001", customerName: "Zákazník bez dodávateľa", placedAt: new Date("2026-07-05T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "N-1", quantity: 1 });

  const openRes = await app.request("/api/orders/open", { headers: { cookie } });
  const openTelo = (await openRes.json()) as { suppliers: { supplier: string; lines: unknown[] }[] };
  const bezDodavatela = openTelo.suppliers.find((s) => s.supplier === "(bez dodávateľa)");
  expect(bezDodavatela).toBeDefined();
  expect(bezDodavatela?.lines).toHaveLength(1);

  const detailRes = await app.request(`/api/orders/${objednavka.id}`, { headers: { cookie } });
  const detailTelo = (await detailRes.json()) as { lines: { supplier: string }[] };
  expect(detailTelo.lines[0]?.supplier).toBe("(bez dodávateľa)");
});

it("vráti detail objednávky so všetkými riadkami, 404 pre neznáme id, 400 pre neplatné id", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "A-1", "Dodávateľ Alfa");
  const [objednavka] = await db
    .insert(orders)
    .values({
      externalOrderId: "2001",
      customerName: "Zákazník",
      comment: "Zavolať pred doručením",
      placedAt: new Date("2026-07-10T00:00:00Z"),
    })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "A-1", quantity: 3 });

  const detailRes = await app.request(`/api/orders/${objednavka.id}`, { headers: { cookie } });
  expect(detailRes.status).toBe(200);
  expect(await detailRes.json()).toMatchObject({
    externalOrderId: "2001",
    customerName: "Zákazník",
    comment: "Zavolať pred doručením",
    lines: [{ variantCode: "A-1", supplier: "Dodávateľ Alfa", quantity: 3, state: "objednane" }],
  });

  const neznameRes = await app.request("/api/orders/11111111-1111-1111-1111-111111111111", { headers: { cookie } });
  expect(neznameRes.status).toBe(404);

  const neplatneRes = await app.request("/api/orders/nie-je-to-uuid", { headers: { cookie } });
  expect(neplatneRes.status).toBe(400);
});

// `insertTestVariant`/o dôvod, prečo je každá rola SAMOSTATNÝM `it()` a nie
// tromi po sebe idúcimi `boot()` volaniami v jednom teste: `withCleanDb()`
// berie exkluzívny session-scoped zámok a druhé volanie TRUNCATE-uje tie isté
// zdieľané tabuľky (`.claude/rules/testing.md`) — samostatné testy sú tu
// jednoduchšie než zdieľať jeden `boot()`/prihlásiť sa pod tromi rolami.
const fakeAcceptedResult: OrdersIngestResult = {
  status: "accepted",
  orderCount: 0,
  lineCount: 0,
  skippedItemCount: 0,
  pseudoItemCount: 0,
  issueCount: 0,
  rawPath: "/tmp/fake.csv.gz",
};

it("rola citanie nesmie spustiť import objednávok", async () => {
  const { app, cookie } = await boot("citanie", () => Promise.resolve(fakeAcceptedResult));
  expect((await app.request("/api/orders/ingest", { method: "POST", headers: { cookie } })).status).toBe(403);
});

it("rola sef tiež nesmie spustiť import objednávok — obe neprivilegované role sú overené, nielen jedna", async () => {
  const { app, cookie } = await boot("sef", () => Promise.resolve(fakeAcceptedResult));
  expect((await app.request("/api/orders/ingest", { method: "POST", headers: { cookie } })).status).toBe(403);
});

it("rola manazer smie spustiť import objednávok", async () => {
  const { app, cookie } = await boot("manazer", () => Promise.resolve(fakeAcceptedResult));
  expect((await app.request("/api/orders/ingest", { method: "POST", headers: { cookie } })).status).toBe(200);
});

it("import objednávok s cudzím Origin je odmietnutý (403), rovnaký pôvod prejde", async () => {
  const runOrdersIngest: RunOrdersIngest = () =>
    Promise.resolve({
      status: "accepted",
      orderCount: 0,
      lineCount: 0,
      skippedItemCount: 0,
      pseudoItemCount: 0,
      issueCount: 0,
      rawPath: "/tmp/fake.csv.gz",
    });
  const { app, cookie } = await boot("manazer", runOrdersIngest);

  const cudzi = await app.request("/api/orders/ingest", {
    method: "POST",
    headers: { cookie, origin: "https://utocnik.example", host: "forestshop.example" },
  });
  expect(cudzi.status).toBe(403);

  const rovnaky = await app.request("/api/orders/ingest", {
    method: "POST",
    headers: { cookie, origin: "https://forestshop.example", host: "forestshop.example" },
  });
  expect(rovnaky.status).toBe(200);
});

it("bez nakonfigurovanej SHOPTET_ORDERS_URL vráti import 503", async () => {
  const { app, cookie } = await boot("manazer");
  const res = await app.request("/api/orders/ingest", { method: "POST", headers: { cookie } });
  expect(res.status).toBe(503);
});

it("keď sa export nedá vôbec stiahnuť, vráti sa jasná hláška (nie 500) a zapíše sa dôkaz o pokuse", async () => {
  const runOrdersIngest: RunOrdersIngest = () => Promise.reject(new Error("fetch failed: connect ECONNREFUSED"));
  const { app, cookie, db, userId } = await boot("manazer", runOrdersIngest);

  const res = await app.request("/api/orders/ingest", { method: "POST", headers: { cookie } });
  expect(res.status).toBe(502);
  const telo = (await res.json()) as { error: string };
  expect(telo.error).toMatch(/stiahnuť/);
  expect(telo.error).not.toContain("ECONNREFUSED");

  const udalosti = await db.select().from(auditEvents);
  const udalost = udalosti.find((e) => e.action === "orders.ingest.trigger");
  expect(udalost).toBeDefined();
  expect(udalost?.actorUserId).toBe(userId);
  expect(udalost?.data).toMatchObject({ status: "fetch_failed" });
});

it("ručný import spustí manažér a zapíše sa do auditu so skutočným výsledkom", async () => {
  const fakeResult: OrdersIngestResult = {
    status: "accepted",
    orderCount: 1,
    lineCount: 1,
    skippedItemCount: 0,
    pseudoItemCount: 0,
    issueCount: 0,
    rawPath: "/tmp/fake.csv.gz",
  };
  const runOrdersIngest: RunOrdersIngest = () => Promise.resolve(fakeResult);
  const { app, cookie, db, userId } = await boot("manazer", runOrdersIngest);

  const res = await app.request("/api/orders/ingest", { method: "POST", headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ status: "accepted", orderCount: 1, lineCount: 1 });

  const udalosti = await db.select().from(auditEvents);
  const udalost = udalosti.find((e) => e.action === "orders.ingest.trigger");
  expect(udalost).toBeDefined();
  expect(udalost?.actorUserId).toBe(userId);
  expect(udalost?.data).toMatchObject({ status: "accepted" });
});

it("druhé súbežné spustenie importu vráti busy namiesto paralelného behu", async () => {
  let volani = 0;
  let dokonci: ((result: OrdersIngestResult) => void) | undefined;
  const runOrdersIngest: RunOrdersIngest = () => {
    volani += 1;
    return new Promise((resolve) => {
      dokonci = resolve;
    });
  };
  const { app, cookie } = await boot("manazer", runOrdersIngest);

  const prvyPromise = app.request("/api/orders/ingest", { method: "POST", headers: { cookie } });
  await vi.waitFor(() => {
    if (volani < 1) throw new Error("runOrdersIngest ešte nebolo zavolané");
  });

  const druhy = await app.request("/api/orders/ingest", { method: "POST", headers: { cookie } });
  expect(druhy.status).toBe(200);
  expect((await druhy.json()) as { status: string }).toEqual({ status: "busy" });

  dokonci?.({
    status: "accepted",
    orderCount: 0,
    lineCount: 0,
    skippedItemCount: 0,
    pseudoItemCount: 0,
    issueCount: 0,
    rawPath: "/tmp/fake.csv.gz",
  });
  const prvy = await prvyPromise;
  expect(prvy.status).toBe(200);
  expect((await prvy.json()) as { status: string }).toMatchObject({ status: "accepted" });
});

// #25: zmena stavu riadku objednávky + audit.
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
