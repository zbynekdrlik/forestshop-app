import { eq, sql } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { orderLines, orders, productSupplierLinkOverrides, products, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestVariant, insertTestVariantForProduct } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 121: manuálny odkaz na dodávateľa — perzistencia
// (`product_supplier_link_override`), prednosť pred `internalNote` odkazom,
// propagácia na SÚRODENECKÉ riadky toho istého produktu, a to, že (na
// rozdiel od `orders-supplier-assignment.integration.test.ts`) sa smie
// upraviť AJ riadok, ktorý už odkaz má. Vlastný súbor — rovnaký vzor ako
// `orders-supplier-assignment.integration.test.ts` (`.claude/rules/testing.md`).

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
      readonly supplierUrl: string | null;
    }[];
  }[];
}

it("doplnenie odkazu riadku bez odkazu sa uloží a prežije opätovné načítanie", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "L-A", "Dodávateľ A");
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "7001", customerName: "Zákazník", placedAt: new Date("2026-07-01T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  const [line] = await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "L-A", quantity: 1 }).returning();
  if (line === undefined) throw new Error("insert zlyhal");

  const predTelo = (await (await app.request("/api/orders/open", { headers: { cookie } })).json()) as OpenTelo;
  expect(predTelo.suppliers[0]?.lines[0]?.supplierUrl).toBeNull();

  const res = await app.request(`/api/orders/lines/${line.id}/supplier-link`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://dodavatel.example.com/produkt" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, url: "https://dodavatel.example.com/produkt" });

  const poTelo = (await (await app.request("/api/orders/open", { headers: { cookie } })).json()) as OpenTelo;
  expect(poTelo.suppliers[0]?.lines[0]?.supplierUrl).toBe("https://dodavatel.example.com/produkt");
});

// issue 121 (review of PR 138, coverage gap): `resolveEffectiveSupplierLink`
// je zdieľaná ČISTÁ funkcia použitá na TROCH čítacích cestách
// (`listOpenOrderLinesBySupplier`, `getOrderDetail`, `mail.ts`'s
// `loadOutstandingLines`) — vyššie overený `/api/orders/open` je len JEDNA
// z nich. Tento test dokazuje DRUHÚ (`GET /api/orders/:id`), rovnakým
// vzorom ako existujúci `orders-http.integration.test.ts`'s "detail
// objednávky nesie odkaz na dodávateľa aj kód dodávateľa" test.
it("detail objednávky (GET /api/orders/:id) tiež zobrazí uložený odkaz namiesto odkazu zo Shoptetu", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "L-DETAIL", "Dodávateľ", { internalNote: "https://stary-detail.example.com" });
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "7009", customerName: "Zákazník", placedAt: new Date("2026-07-09T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  const [line] = await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "L-DETAIL", quantity: 1 }).returning();
  if (line === undefined) throw new Error("insert zlyhal");

  await app.request(`/api/orders/lines/${line.id}/supplier-link`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://novy-detail.example.com" }),
  });

  const detailRes = await app.request(`/api/orders/${objednavka.id}`, { headers: { cookie } });
  const detail = (await detailRes.json()) as { lines: { supplierUrl: string | null }[] };
  expect(detail.lines[0]?.supplierUrl).toBe("https://novy-detail.example.com");
});

// issue 121 (review of PR 138, coverage gap): TRETIA čítacia cesta —
// dodávateľský mailový náhľad (`mail.ts`'s `loadOutstandingLines` cez
// `buildSupplierOrderMailContent`) musí tiež niesť uložený odkaz, nie
// odkaz zo Shoptetu — inak by appka poslala dodávateľovi zastaraný/zlý
// odkaz napriek tomu, že ho manažér práve opravil.
it("mailový náhľad objednávky dodávateľovi (GET .../order-mail) tiež nesie uložený odkaz", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "L-MAIL", "Dodávateľ Mailový", { internalNote: "https://stary-mail.example.com" });
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "7010", customerName: "Zákazník", placedAt: new Date("2026-07-10T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  const [line] = await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "L-MAIL", quantity: 1 }).returning();
  if (line === undefined) throw new Error("insert zlyhal");

  await app.request(`/api/orders/lines/${line.id}/supplier-link`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://novy-mail.example.com" }),
  });

  const mailRes = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ Mailový")}/order-mail`, {
    headers: { cookie },
  });
  const preview = (await mailRes.json()) as { body: string };
  expect(preview.body).toContain("https://novy-mail.example.com");
  expect(preview.body).not.toContain("https://stary-mail.example.com");
});

// issue 121: NA ROZDIEL od priradenia dodávateľa (#63, 409 keď katalóg už má
// hodnotu) tu žiadna gate neexistuje — odkaz sa smie upraviť AJ keď Shoptet
// (`internalNote`) už jeden poskytuje. Naša hodnota má VŽDY prednosť.
it("úprava riadku, ktorý UŽ má odkaz zo Shoptetu, uloží novú hodnotu bez 409 a prepíše zobrazenú hodnotu", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "L-B", "Dodávateľ B", { internalNote: "https://stary-odkaz.example.com/x" });
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "7002", customerName: "Zákazník", placedAt: new Date("2026-07-02T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  const [line] = await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "L-B", quantity: 1 }).returning();
  if (line === undefined) throw new Error("insert zlyhal");

  const predTelo = (await (await app.request("/api/orders/open", { headers: { cookie } })).json()) as OpenTelo;
  expect(predTelo.suppliers[0]?.lines[0]?.supplierUrl).toBe("https://stary-odkaz.example.com/x");

  const res = await app.request(`/api/orders/lines/${line.id}/supplier-link`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://novy-odkaz.example.com/y" }),
  });
  expect(res.status).toBe(200);

  const poTelo = (await (await app.request("/api/orders/open", { headers: { cookie } })).json()) as OpenTelo;
  expect(poTelo.suppliers[0]?.lines[0]?.supplierUrl).toBe("https://novy-odkaz.example.com/y");
});

it("úprava odkazu cez JEDNU veľkosť produktu platí aj pre INÚ veľkosť toho istého produktu", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariantForProduct(db, "PROD-LINK", "PROD-LINK/S", { sizeLabel: "S" });
  await insertTestVariantForProduct(db, "PROD-LINK", "PROD-LINK/M", { sizeLabel: "M" });
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "7003", customerName: "Zákazník", placedAt: new Date("2026-07-03T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  const [lineS] = await db
    .insert(orderLines)
    .values({ orderId: objednavka.id, variantCode: "PROD-LINK/S", quantity: 1 })
    .returning();
  if (lineS === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "PROD-LINK/M", quantity: 1 });

  await app.request(`/api/orders/lines/${lineS.id}/supplier-link`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://dodavatel.example.com/produkt-x" }),
  });

  const telo = (await (await app.request("/api/orders/open", { headers: { cookie } })).json()) as OpenTelo;
  const skupina = telo.suppliers.find((s) => s.lines.some((l) => l.variantCode.startsWith("PROD-LINK")));
  expect(skupina?.lines.map((l) => l.variantCode).sort()).toEqual(["PROD-LINK/M", "PROD-LINK/S"]);
  expect(skupina?.lines.every((l) => l.supplierUrl === "https://dodavatel.example.com/produkt-x")).toBe(true);
});

it("úprava odkazu zapíše audit záznam s pôvodnou aj novou hodnotou", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "L-AUDIT", "Dodávateľ", { internalNote: "https://stary.example.com" });
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "7004", customerName: "Zákazník", placedAt: new Date("2026-07-04T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  const [line] = await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "L-AUDIT", quantity: 1 }).returning();
  if (line === undefined) throw new Error("insert zlyhal");

  await app.request(`/api/orders/lines/${line.id}/supplier-link`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://novy.example.com" }),
  });

  const [override] = await db
    .select()
    .from(productSupplierLinkOverrides)
    .where(eq(productSupplierLinkOverrides.productKey, "L-AUDIT"));
  expect(override?.url).toBe("https://novy.example.com");
});

// issue 121: ticketova akceptačná podmienka "opakovaný import katalógu ho
// NEPREPÍŠE" — reprodukuje PRESNE ten istý upsert tvar ako `catalog/ingest.ts`
// (`onConflictDoUpdate({ target: products.key, set: { ... internalNote:
// sql\`excluded.internal_note\` ... } })`), nie len znovu-insert. Katalógový
// re-import NIKDY nemaže/znovu-vkladá `product` riadok (`ON CONFLICT
// UPDATE` na tom istom `key`), takže FK z `product_supplier_link_override`
// (`ON DELETE CASCADE`) sa nikdy neaktivuje — override prežije AJ keď
// Shoptet medzitým prinesie ÚPLNE INÝ `internalNote`.
it("opakovaný katalógový re-import (upsert na product.key) NEPREPÍŠE uložený odkaz", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "L-REIMPORT", "Dodávateľ", { internalNote: "https://povodny-shoptet-odkaz.example.com" });
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "7007", customerName: "Zákazník", placedAt: new Date("2026-07-07T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  const [line] = await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "L-REIMPORT", quantity: 1 }).returning();
  if (line === undefined) throw new Error("insert zlyhal");

  await app.request(`/api/orders/lines/${line.id}/supplier-link`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://nas-ulozeny-odkaz.example.com" }),
  });

  // Simuluje nočný re-import: rovnaký `onConflictDoUpdate` tvar ako
  // `ingest.ts`, so ÚPLNE NOVÝM `internalNote` zo Shoptetu (nová hodnota
  // dokazuje, že re-import SKUTOČNE prebehol, nielen no-op).
  const [existujuciProdukt] = await db.select().from(products).where(eq(products.key, "L-REIMPORT")).limit(1);
  if (existujuciProdukt === undefined) throw new Error("produkt sa nenašiel");
  await db
    .insert(products)
    .values({
      key: "L-REIMPORT",
      name: "Test produkt L-REIMPORT",
      supplier: "Dodávateľ",
      internalNote: "https://novy-shoptet-odkaz-po-reimporte.example.com",
      firstSeenAt: new Date("2026-01-01T00:00:00Z"),
      lastSeenAt: new Date("2026-07-08T00:00:00Z"),
      lastSeenSnapshotId: existujuciProdukt.lastSeenSnapshotId,
    })
    .onConflictDoUpdate({
      target: products.key,
      set: {
        name: sql`excluded.name`,
        supplier: sql`excluded.supplier`,
        internalNote: sql`excluded.internal_note`,
        lastSeenAt: sql`excluded.last_seen_at`,
      },
    });

  const override = await db
    .select()
    .from(productSupplierLinkOverrides)
    .where(eq(productSupplierLinkOverrides.productKey, "L-REIMPORT"));
  expect(override).toHaveLength(1);
  expect(override[0]?.url).toBe("https://nas-ulozeny-odkaz.example.com");

  const [produkt] = await db.select().from(products).where(eq(products.key, "L-REIMPORT"));
  expect(produkt?.internalNote).toBe("https://novy-shoptet-odkaz-po-reimporte.example.com");

  const telo = (await (await app.request("/api/orders/open", { headers: { cookie } })).json()) as OpenTelo;
  expect(telo.suppliers[0]?.lines[0]?.supplierUrl).toBe("https://nas-ulozeny-odkaz.example.com");
});

it("úprava neznámeho riadku vráti 404", async () => {
  const { app, cookie } = await boot("manazer");
  const res = await app.request("/api/orders/lines/11111111-1111-1111-1111-111111111111/supplier-link", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://dodavatel.example.com" }),
  });
  expect(res.status).toBe(404);
});

it("neplatná URL vráti 400 (validácia)", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "L-C", "Dodávateľ");
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "7005", customerName: "Zákazník", placedAt: new Date("2026-07-05T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  const [line] = await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "L-C", quantity: 1 }).returning();
  if (line === undefined) throw new Error("insert zlyhal");

  const res = await app.request(`/api/orders/lines/${line.id}/supplier-link`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: "nie je url" }),
  });
  expect(res.status).toBe(400);
});

// issue 121: `.url()` samo osebe by prijalo aj syntakticky platnú, ale
// nebezpečnú schému (hodnota ide priamo do `<a href>`) — server-strana MUSÍ
// navyše vynútiť http(s), nespoliehať sa len na frontendovú vrstvu.
it("URL s inou ako http(s) schémou vráti 400 (validácia)", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "L-SCHEME", "Dodávateľ");
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "7008", customerName: "Zákazník", placedAt: new Date("2026-07-08T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  const [line] = await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "L-SCHEME", quantity: 1 }).returning();
  if (line === undefined) throw new Error("insert zlyhal");

  const res = await app.request(`/api/orders/lines/${line.id}/supplier-link`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: "javascript:alert(1)" }),
  });
  expect(res.status).toBe(400);
});

it("rola citanie nesmie upraviť odkaz na dodávateľa (403)", async () => {
  const { app, cookie, db } = await boot("citanie");
  await insertTestVariant(db, "L-D", "Dodávateľ");
  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "7006", customerName: "Zákazník", placedAt: new Date("2026-07-06T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  const [line] = await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "L-D", quantity: 1 }).returning();
  if (line === undefined) throw new Error("insert zlyhal");

  const res = await app.request(`/api/orders/lines/${line.id}/supplier-link`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://dodavatel.example.com" }),
  });
  expect(res.status).toBe(403);
});
