import { afterEach, expect, it } from "vitest";
import { orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestVariant, insertTestVariantForProduct } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 240: "Eshop → Vyhľadať" — `GET /api/search?q=` hľadá naprieč
// katalógom (produkty/varianty) aj objednávkami, vracia DVE oddelené polia
// (produkty prirodzene pred objednávkami, žiadna umelá relevance logika).

const HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot(role: UserRole = "manazer") {
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

interface SearchTelo {
  readonly products: {
    readonly productKey: string;
    readonly variantCode: string;
    readonly productName: string;
    readonly sizeLabel: string | null;
    readonly supplier: string | null;
    readonly externalCode: string | null;
    readonly state: string;
  }[];
  readonly orders: {
    readonly orderId: string;
    readonly externalOrderId: string;
    readonly customerName: string;
    readonly email: string | null;
    readonly statusName: string;
    readonly placedAt: string;
    readonly adminUrl: string;
  }[];
}

it("bez prihlásenia vráti 401", async () => {
  const { app } = await boot();
  expect((await app.request("/api/search?q=nieco")).status).toBe(401);
});

it("prázdne alebo chýbajúce q vráti obe polia prázdne", async () => {
  const { app, cookie, db } = await boot();
  await insertTestVariant(db, "SRCH-EMPTY", "Test dodávateľ");

  const bezQ = (await (await app.request("/api/search", { headers: { cookie } })).json()) as SearchTelo;
  expect(bezQ).toEqual({ products: [], orders: [] });

  const prazdneQ = (await (await app.request("/api/search?q=", { headers: { cookie } })).json()) as SearchTelo;
  expect(prazdneQ).toEqual({ products: [], orders: [] });
});

it("nájde produkt podľa kódu variantu", async () => {
  const { app, cookie, db } = await boot();
  await insertTestVariant(db, "SRCH-1", "Dodávateľ Hľadanie");

  const telo = (await (await app.request("/api/search?q=SRCH-1", { headers: { cookie } })).json()) as SearchTelo;
  expect(telo.products).toHaveLength(1);
  expect(telo.products[0]).toEqual({
    productKey: "SRCH-1",
    variantCode: "SRCH-1",
    productName: "Test produkt SRCH-1",
    sizeLabel: null,
    supplier: "Dodávateľ Hľadanie",
    externalCode: null,
    state: "sellable",
  });
  expect(telo.orders).toEqual([]);
});

it("nájde produkt podľa časti názvu (case-insensitive)", async () => {
  const { app, cookie, db } = await boot();
  await insertTestVariantForProduct(db, "SRCH-2", "SRCH-2", { productName: "Zvláštna Bunda Alfa" });

  const telo = (await (await app.request("/api/search?q=bunda alfa", { headers: { cookie } })).json()) as SearchTelo;
  expect(telo.products.some((p) => p.productKey === "SRCH-2")).toBe(true);
});

it("nájde produkt podľa dodávateľa", async () => {
  const { app, cookie, db } = await boot();
  await insertTestVariant(db, "SRCH-3", "Jedinečný Dodávateľ XYZ");

  const telo = (await (await app.request("/api/search?q=Jedinečný Dodávateľ", { headers: { cookie } })).json()) as SearchTelo;
  expect(telo.products.some((p) => p.productKey === "SRCH-3")).toBe(true);
});

it("nájde produkt podľa kódu u dodávateľa (externalCode)", async () => {
  const { app, cookie, db } = await boot();
  await insertTestVariant(db, "SRCH-4", "Dodávateľ", { externalCode: "EXT-JEDINECNY-KOD" });

  const telo = (await (await app.request("/api/search?q=EXT-JEDINECNY-KOD", { headers: { cookie } })).json()) as SearchTelo;
  expect(telo.products.some((p) => p.productKey === "SRCH-4")).toBe(true);
});

it("nájde objednávku podľa čísla objednávky, produkty ostanú prázdne", async () => {
  const { app, cookie, db } = await boot();
  const [objednavka] = await db
    .insert(orders)
    .values({
      externalOrderId: "SRCH-ORDER-1",
      customerName: "Nesúvisiaci Zákazník",
      placedAt: new Date("2026-07-01T10:00:00Z"),
    })
    .returning();
  expect(objednavka).toBeDefined();

  const telo = (await (await app.request("/api/search?q=SRCH-ORDER-1", { headers: { cookie } })).json()) as SearchTelo;
  expect(telo.products).toEqual([]);
  expect(telo.orders).toHaveLength(1);
  expect(telo.orders[0]?.externalOrderId).toBe("SRCH-ORDER-1");
  expect(telo.orders[0]?.customerName).toBe("Nesúvisiaci Zákazník");
  expect(telo.orders[0]?.adminUrl).toBe(
    "https://www.forestshop.sk/admin/vyhladavanie/?string=SRCH-ORDER-1&src=orders",
  );
});

it("nájde objednávku podľa mena zákazníka", async () => {
  const { app, cookie, db } = await boot();
  await db.insert(orders).values({
    externalOrderId: "9501",
    customerName: "Jedinečné Meno Testovacie",
    placedAt: new Date("2026-07-01T10:00:00Z"),
  });

  const telo = (await (await app.request("/api/search?q=jedinečné meno", { headers: { cookie } })).json()) as SearchTelo;
  expect(telo.orders.some((o) => o.externalOrderId === "9501")).toBe(true);
});

it("nájde objednávku podľa e-mailu zákazníka", async () => {
  const { app, cookie, db } = await boot();
  await db.insert(orders).values({
    externalOrderId: "9502",
    customerName: "Niekto Iný",
    email: "unikatny-email@example.com",
    placedAt: new Date("2026-07-01T10:00:00Z"),
  });

  const telo = (await (await app.request("/api/search?q=unikatny-email", { headers: { cookie } })).json()) as SearchTelo;
  expect(telo.orders.some((o) => o.externalOrderId === "9502")).toBe(true);
});

it("produkt aj objednávka sa nájdu naraz ako dve oddelené polia", async () => {
  const { app, cookie, db } = await boot();
  await insertTestVariant(db, "SPOLOCNE-X", "Dodávateľ");
  await db.insert(orders).values({
    externalOrderId: "9503",
    customerName: "Zákazník SPOLOCNE-X",
    placedAt: new Date("2026-07-01T10:00:00Z"),
  });

  const telo = (await (await app.request("/api/search?q=SPOLOCNE-X", { headers: { cookie } })).json()) as SearchTelo;
  expect(telo.products.some((p) => p.productKey === "SPOLOCNE-X")).toBe(true);
  expect(telo.orders.some((o) => o.externalOrderId === "9503")).toBe(true);
});

it("hľadanie s internom Shoptet id objednávky použije priamy odkaz na detail", async () => {
  const { app, cookie, db } = await boot();
  await db.insert(orders).values({
    externalOrderId: "9504",
    customerName: "Priamy Odkaz",
    shoptetOrderId: 555_111,
    placedAt: new Date("2026-07-01T10:00:00Z"),
  });

  const telo = (await (await app.request("/api/search?q=9504", { headers: { cookie } })).json()) as SearchTelo;
  expect(telo.orders[0]?.adminUrl).toBe("https://www.forestshop.sk/admin/objednavky-detail/?id=555111");
});
