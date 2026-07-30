import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { orderLines, orders, productSupplierOverrides, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestVariant, insertTestVariantForProduct } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 63: ručné priradenie dodávateľa riadku bez dodávateľa — perzistencia
// (`product_supplier_override`), presun do novej skupiny, propagácia na
// SÚRODENECKÉ riadky toho istého produktu, a case/whitespace-tolerantné
// zlúčenie skupín (aj v hromadnej akcii/maile, nielen v hlavnom zozname).
// Vydelené z `orders-http.integration.test.ts`, aby ani jeden nenarástol cez
// eslint `max-lines` (`.claude/rules/testing.md`).

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
  return { app, cookie, db: ctx.db };
}

interface OpenTelo {
  readonly suppliers: {
    readonly supplier: string;
    readonly lines: {
      readonly lineId: string;
      readonly variantCode: string;
      readonly supplierAssignable: boolean;
      readonly manualSupplierOverride: string | null;
    }[];
  }[];
}

it("manažér priradí dodávateľa riadku bez dodávateľa — riadok sa presunie do novej skupiny a priradenie zostane po opätovnom načítaní", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "N-A", null);
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "6001", customerName: "Zákazník", placedAt: new Date("2026-07-01T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  const [line] = await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "N-A", quantity: 2 }).returning();
  if (line === undefined) throw new Error("insert zlyhal");

  const predTelo = (await (await app.request("/api/orders/open", { headers: { cookie } })).json()) as OpenTelo;
  const bezDodavatela = predTelo.suppliers.find((s) => s.supplier === "(bez dodávateľa)");
  expect(bezDodavatela?.lines[0]).toMatchObject({ supplierAssignable: true, manualSupplierOverride: null });

  const priradenieRes = await app.request(`/api/orders/lines/${line.id}/supplier`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ supplier: "Nový Dodávateľ" }),
  });
  expect(priradenieRes.status).toBe(200);
  expect(await priradenieRes.json()).toEqual({ ok: true, supplier: "Nový Dodávateľ" });

  const poTelo = (await (await app.request("/api/orders/open", { headers: { cookie } })).json()) as OpenTelo;
  expect(poTelo.suppliers.find((s) => s.supplier === "(bez dodávateľa)")).toBeUndefined();
  const novaSkupina = poTelo.suppliers.find((s) => s.supplier === "Nový Dodávateľ");
  expect(novaSkupina?.lines).toHaveLength(1);
  expect(novaSkupina?.lines[0]).toMatchObject({
    variantCode: "N-A",
    supplierAssignable: true,
    manualSupplierOverride: "Nový Dodávateľ",
  });
});

it("priradenie cez JEDNU veľkosť produktu platí aj pre INÚ veľkosť toho istého produktu", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariantForProduct(db, "PROD-X", "PROD-X/S", { supplier: null, sizeLabel: "S" });
  await insertTestVariantForProduct(db, "PROD-X", "PROD-X/M", { supplier: null, sizeLabel: "M" });
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "6002", customerName: "Zákazník", placedAt: new Date("2026-07-02T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  const [lineS] = await db
    .insert(orderLines)
    .values({ orderId: objednavka.id, variantCode: "PROD-X/S", quantity: 1 })
    .returning();
  if (lineS === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "PROD-X/M", quantity: 1 });

  await app.request(`/api/orders/lines/${lineS.id}/supplier`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ supplier: "Dodávateľ Produktu X" }),
  });

  const telo = (await (await app.request("/api/orders/open", { headers: { cookie } })).json()) as OpenTelo;
  const skupina = telo.suppliers.find((s) => s.supplier === "Dodávateľ Produktu X");
  expect(skupina?.lines.map((l) => l.variantCode).sort()).toEqual(["PROD-X/M", "PROD-X/S"]);
  expect(skupina?.lines.every((l) => l.manualSupplierOverride === "Dodávateľ Produktu X")).toBe(true);
});

it("dva pravopisy (case/whitespace) toho istého dodávateľa sa zlúčia do JEDNEJ skupiny — hromadná akcia aj mail zasiahnu OBE", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "CASE-A", "Foo Bar");
  await insertTestVariant(db, "CASE-B", "Foo Bar");
  await insertTestVariant(db, "CASE-C", null);
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "6003", customerName: "Zákazník", placedAt: new Date("2026-07-03T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values([
    { orderId: objednavka.id, variantCode: "CASE-A", quantity: 1 },
    { orderId: objednavka.id, variantCode: "CASE-B", quantity: 1 },
  ]);
  const [lineC] = await db
    .insert(orderLines)
    .values({ orderId: objednavka.id, variantCode: "CASE-C", quantity: 5 })
    .returning();
  if (lineC === undefined) throw new Error("insert zlyhal");

  // Manažér zapíše dodávateľa s INÝM pravopisom (medzery navyše, iná
  // veľkosť písmen) než ako je uložený v katalógu pre CASE-A/CASE-B.
  await app.request(`/api/orders/lines/${lineC.id}/supplier`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ supplier: "  foo   BAR  " }),
  });

  const telo = (await (await app.request("/api/orders/open", { headers: { cookie } })).json()) as OpenTelo;
  // "Foo Bar" má 2 riadky (CASE-A, CASE-B), "  foo   BAR  " po orezaní má 1
  // ("foo BAR") — najčastejší pravopis ("Foo Bar") vyhráva zobrazenie.
  const skupina = telo.suppliers.find((s) => s.supplier === "Foo Bar");
  expect(skupina?.lines.map((l) => l.variantCode).sort()).toEqual(["CASE-A", "CASE-B", "CASE-C"]);
  expect(telo.suppliers).toHaveLength(1);

  // Hromadné "objednané" pre skupinu "Foo Bar" musí zasiahnuť VŠETKY tri.
  const bulkRes = await app.request(`/api/suppliers/${encodeURIComponent("Foo Bar")}/order-lines/ordered`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ordered: true }),
  });
  expect(await bulkRes.json()).toMatchObject({ ok: true, lineCount: 3 });

  // Mailový náhľad pre tú istú skupinu musí tiež agregovať cez OBA
  // pravopisy — inak by dodávateľ nedostal položku CASE-C.
  const mailRes = await app.request(`/api/suppliers/${encodeURIComponent("Foo Bar")}/order-mail`, { headers: { cookie } });
  expect(await mailRes.json()).toMatchObject({ itemCount: 3 });
});

it("priradenie neznámeho riadku vráti 404, prázdny reťazec vráti 400", async () => {
  const { app, cookie } = await boot("manazer");
  const neznamy = await app.request("/api/orders/lines/11111111-1111-1111-1111-111111111111/supplier", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ supplier: "Niekto" }),
  });
  expect(neznamy.status).toBe(404);
});

it("priradenie s prázdnym dodávateľom vráti 400 (validácia)", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "N-B", null);
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "6004", customerName: "Zákazník", placedAt: new Date("2026-07-04T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  const [line] = await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "N-B", quantity: 1 }).returning();
  if (line === undefined) throw new Error("insert zlyhal");

  const res = await app.request(`/api/orders/lines/${line.id}/supplier`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ supplier: "   " }),
  });
  expect(res.status).toBe(400);
});

it("rola citanie nesmie priradiť dodávateľa (403)", async () => {
  const { app, cookie, db } = await boot("citanie");
  await insertTestVariant(db, "N-C", null);
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "6005", customerName: "Zákazník", placedAt: new Date("2026-07-06T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  const [line] = await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "N-C", quantity: 1 }).returning();
  if (line === undefined) throw new Error("insert zlyhal");

  const res = await app.request(`/api/orders/lines/${line.id}/supplier`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ supplier: "Niekto" }),
  });
  expect(res.status).toBe(403);
});

// issue 86 (nezávislý audit): server dovtedy vôbec neoveroval, že produkt
// nemá dodávateľa v katalógu — pravidlo bolo vynucované LEN vo frontende.
// Riadok, ktorého produkt UŽ má `product.supplier` vyplnené, nesmie ísť
// priradiť ručne, a NESMIE sa pri tom zapísať žiadny `product_supplier_
// override` riadok (dormantný override, čo by sa neskôr potichu aktivoval).
it("priradenie riadku, ktorého produkt UŽ má dodávateľa v katalógu, vráti 409 a nezapíše override", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "N-D", "Existujúci Katalógový Dodávateľ");
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "6006", customerName: "Zákazník", placedAt: new Date("2026-07-07T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  const [line] = await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "N-D", quantity: 1 }).returning();
  if (line === undefined) throw new Error("insert zlyhal");

  const res = await app.request(`/api/orders/lines/${line.id}/supplier`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ supplier: "Ručne Napísaný Dodávateľ" }),
  });
  expect(res.status).toBe(409);

  const override = await db.select().from(productSupplierOverrides).where(eq(productSupplierOverrides.productKey, "N-D"));
  expect(override).toHaveLength(0);
});

// issue 86 (nezávislý audit): `.max(200)` na `orderLineSupplierBody`,
// rovnaká horná hranica ako ostatné voľné textové vstupy v projekte.
it("priradenie dodávateľa s reťazcom nad 200 znakov vráti 400 (validácia)", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "N-E", null);
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "6007", customerName: "Zákazník", placedAt: new Date("2026-07-08T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  const [line] = await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "N-E", quantity: 1 }).returning();
  if (line === undefined) throw new Error("insert zlyhal");

  const res = await app.request(`/api/orders/lines/${line.id}/supplier`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ supplier: "x".repeat(201) }),
  });
  expect(res.status).toBe(400);
});
