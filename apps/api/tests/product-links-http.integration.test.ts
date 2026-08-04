import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { productSupplierLinkOverrides, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestVariant, insertTestVariantForProduct } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 239: "Eshop → Párovanie produktov" — zoznam produktov bez
// dodávateľskej linky + doplnenie/oprava, zapisuje do TEJ ISTEJ
// `product_supplier_link_override` tabuľky ako #121 (rovnaký vzor testov ako
// `orders-supplier-link-assignment.integration.test.ts`, len nad NOVOU
// PRODUKTOVOU trasou namiesto riadku objednávky).

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

interface ListTelo {
  readonly total: number;
  readonly missingTotal: number;
  readonly items: {
    readonly productKey: string;
    readonly productName: string;
    readonly supplier: string | null;
    readonly variantCount: number;
    readonly url: string | null;
    readonly updatedAt: string | null;
    readonly syncedAt: string | null;
  }[];
}

it("bez prihlásenia vráti 401 na oboch trasách", async () => {
  const { app } = await boot("manazer");
  expect((await app.request("/api/product-links")).status).toBe(401);
  expect(
    (
      await app.request("/api/product-links/NEJAKY-KEY", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://dodavatel.example.com" }),
      })
    ).status,
  ).toBe(401);
});

it("produkt bez internalNote a bez override sa zobrazí v stave 'missing' s počtom variantov", async () => {
  const { app, cookie, db } = await boot("citanie"); // čítanie smie vidieť zoznam
  await insertTestVariantForProduct(db, "PL-1", "PL-1/S", { sizeLabel: "S" });
  await insertTestVariantForProduct(db, "PL-1", "PL-1/M", { sizeLabel: "M" });

  const res = await app.request("/api/product-links?state=missing", { headers: { cookie } });
  expect(res.status).toBe(200);
  const telo = (await res.json()) as ListTelo;
  const item = telo.items.find((i) => i.productKey === "PL-1");
  expect(item).toEqual({
    productKey: "PL-1",
    productName: "Test produkt PL-1",
    supplier: "Test dodávateľ",
    variantCount: 2,
    url: null,
    updatedAt: null,
    syncedAt: null,
  });
});

it("produkt s rozpoznateľným odkazom v internalNote sa NEzobrazí v stave 'missing', ale zobrazí v 'linked'", async () => {
  const { app, cookie, db } = await boot("citanie");
  await insertTestVariant(db, "PL-2", "Dodávateľ", { internalNote: "https://dodavatel.example.com/produkt-2" });

  const missing = (await (await app.request("/api/product-links?state=missing", { headers: { cookie } })).json()) as ListTelo;
  expect(missing.items.some((i) => i.productKey === "PL-2")).toBe(false);

  const linked = (await (await app.request("/api/product-links?state=linked", { headers: { cookie } })).json()) as ListTelo;
  const item = linked.items.find((i) => i.productKey === "PL-2");
  expect(item?.url).toBe("https://dodavatel.example.com/produkt-2");
});

it("missingTotal počíta CELÝ katalóg nezávisle od aktuálneho filtra/hľadania", async () => {
  const { app, cookie, db } = await boot("citanie");
  await insertTestVariant(db, "PL-3", "Dodávateľ"); // bez linky
  await insertTestVariant(db, "PL-4", "Dodávateľ", { internalNote: "https://dodavatel.example.com/produkt-4" }); // s linkou

  const telo = (await (await app.request("/api/product-links?state=linked&q=PL-4", { headers: { cookie } })).json()) as ListTelo;
  // `total` je vyfiltrovaný počet (len PL-4), `missingTotal` nezávisí od filtra.
  expect(telo.items).toHaveLength(1);
  expect(telo.missingTotal).toBeGreaterThanOrEqual(1);
});

it("uloženie novej linky priamo podľa productKey (bez riadku objednávky) sa zapíše a prežije opätovné načítanie", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "PL-5", "Dodávateľ");

  const pred = (await (await app.request("/api/product-links?q=PL-5", { headers: { cookie } })).json()) as ListTelo;
  expect(pred.items[0]?.url).toBeNull();

  const res = await app.request("/api/product-links/PL-5", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://e2e-dodavatel.example.com/produkt-5" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, url: "https://e2e-dodavatel.example.com/produkt-5" });

  // `state=all` — predvolený filter je "missing" a uložením linky sa PL-5
  // presunie do "linked" (viac tak nezodpovedá predvolenému stavu).
  const po = (await (await app.request("/api/product-links?q=PL-5&state=all", { headers: { cookie } })).json()) as ListTelo;
  expect(po.items[0]?.url).toBe("https://e2e-dodavatel.example.com/produkt-5");
  expect(po.items[0]?.syncedAt).toBeNull();

  const [override] = await db.select().from(productSupplierLinkOverrides).where(eq(productSupplierLinkOverrides.productKey, "PL-5"));
  expect(override?.url).toBe("https://e2e-dodavatel.example.com/produkt-5");
});

it("oprava UŽ existujúcej linky (aj zo Shoptetu) prepíše hodnotu bez gaty", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "PL-6", "Dodávateľ", { internalNote: "https://stary.example.com" });

  const res = await app.request("/api/product-links/PL-6", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://novy.example.com" }),
  });
  expect(res.status).toBe(200);

  const po = (await (await app.request("/api/product-links?q=PL-6&state=all", { headers: { cookie } })).json()) as ListTelo;
  expect(po.items[0]?.url).toBe("https://novy.example.com");
  void db;
});

it("neznámy productKey vráti 404", async () => {
  const { app, cookie } = await boot("manazer");
  const res = await app.request("/api/product-links/NEEXISTUJE", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://dodavatel.example.com" }),
  });
  expect(res.status).toBe(404);
});

it("neplatná URL vráti 400", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "PL-7", "Dodávateľ");
  const res = await app.request("/api/product-links/PL-7", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: "nie je url" }),
  });
  expect(res.status).toBe(400);
  void db;
});

it("rola citanie nesmie upraviť linku (403)", async () => {
  const { app, cookie, db } = await boot("citanie");
  await insertTestVariant(db, "PL-8", "Dodávateľ");
  const res = await app.request("/api/product-links/PL-8", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://dodavatel.example.com" }),
  });
  expect(res.status).toBe(403);
  void db;
});
