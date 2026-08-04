import { afterEach, expect, it } from "vitest";
import { productSupplierLinkOverrides, shopProductUrl, supplierStock, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestVariant, insertTestVariantForProduct } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 240: "Eshop → Vyhľadať" — detail produktu za výsledkom hľadania.
// Editácia dodávateľskej linky ide cez EXISTUJÚcu trasu
// `POST /api/product-links/:productKey` (#239, vlastné testy tam) — tento
// súbor overuje LEN čítaciu stranu (`GET /api/product-detail/:productKey`).

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

interface DetailTelo {
  readonly productKey: string;
  readonly productName: string;
  readonly supplier: string | null;
  readonly supplierLinkUrl: string | null;
  readonly supplierLinkUpdatedAt: string | null;
  readonly supplierLinkSyncedAt: string | null;
  readonly variants: {
    readonly code: string;
    readonly sizeLabel: string | null;
    readonly stock: number;
    readonly price: string | null;
    readonly state: string;
    readonly ourShopUrl: string | null;
    readonly supplierAvailability: string | null;
    readonly supplierAvailabilityText: string | null;
  }[];
}

it("bez prihlásenia vráti 401", async () => {
  const { app } = await boot();
  expect((await app.request("/api/product-detail/NIEKTO")).status).toBe(401);
});

it("neznámy productKey vráti 404", async () => {
  const { app, cookie } = await boot();
  const res = await app.request("/api/product-detail/NEEXISTUJE", { headers: { cookie } });
  expect(res.status).toBe(404);
});

it("produkt bez internalNote a bez override nemá efektívnu linku ani dostupnosť u dodávateľa", async () => {
  const { app, cookie, db } = await boot();
  await insertTestVariant(db, "PD-1", "Dodávateľ PD");

  const res = await app.request("/api/product-detail/PD-1", { headers: { cookie } });
  expect(res.status).toBe(200);
  const telo = (await res.json()) as DetailTelo;
  expect(telo.productKey).toBe("PD-1");
  expect(telo.productName).toBe("Test produkt PD-1");
  expect(telo.supplier).toBe("Dodávateľ PD");
  expect(telo.supplierLinkUrl).toBeNull();
  expect(telo.supplierLinkUpdatedAt).toBeNull();
  expect(telo.supplierLinkSyncedAt).toBeNull();
  expect(telo.variants).toHaveLength(1);
  expect(telo.variants[0]).toMatchObject({
    code: "PD-1",
    sizeLabel: null,
    stock: 5,
    price: "10.00",
    state: "sellable",
    ourShopUrl: null,
    supplierAvailability: null,
    supplierAvailabilityText: null,
  });
});

it("efektívna linka sa extrahuje z internalNote, keď override neexistuje", async () => {
  const { app, cookie, db } = await boot();
  await insertTestVariant(db, "PD-2", "Dodávateľ", {
    internalNote: "Dodávateľ: Trigona - https://trigona.example.com/produkt-2",
  });

  const telo = (await (await app.request("/api/product-detail/PD-2", { headers: { cookie } })).json()) as DetailTelo;
  expect(telo.supplierLinkUrl).toBe("https://trigona.example.com/produkt-2");
  expect(telo.supplierLinkUpdatedAt).toBeNull(); // žiadny override riadok
});

it("override MÁ vždy prednosť pred linkou z internalNote", async () => {
  const { app, cookie, db } = await boot();
  await insertTestVariant(db, "PD-3", "Dodávateľ", { internalNote: "https://stary.example.com/PD-3" });
  await db.insert(productSupplierLinkOverrides).values({
    productKey: "PD-3",
    url: "https://novy.example.com/PD-3",
    updatedAt: new Date("2026-07-15T09:00:00Z"),
    syncedAt: new Date("2026-07-15T10:00:00Z"),
  });

  const telo = (await (await app.request("/api/product-detail/PD-3", { headers: { cookie } })).json()) as DetailTelo;
  expect(telo.supplierLinkUrl).toBe("https://novy.example.com/PD-3");
  expect(telo.supplierLinkUpdatedAt).toBe(new Date("2026-07-15T09:00:00Z").toISOString());
  expect(telo.supplierLinkSyncedAt).toBe(new Date("2026-07-15T10:00:00Z").toISOString());
});

it("adresa u nás (shop_product_url) sa priradí variantu podľa kódu", async () => {
  const { app, cookie, db } = await boot();
  await insertTestVariant(db, "PD-4", "Dodávateľ");
  await db.insert(shopProductUrl).values({
    code: "PD-4",
    url: "https://www.forestshop.sk/pd-4/",
    fetchedAt: new Date("2026-07-01T00:00:00Z"),
  });

  const telo = (await (await app.request("/api/product-detail/PD-4", { headers: { cookie } })).json()) as DetailTelo;
  expect(telo.variants[0]?.ourShopUrl).toBe("https://www.forestshop.sk/pd-4/");
});

it("dostupnosť u dodávateľa (blanket riadok, size_label='') sa priradí jednovariantnému produktu", async () => {
  const { app, cookie, db } = await boot();
  await insertTestVariant(db, "PD-5", "Dodávateľ", { internalNote: "https://dodavatel.example.com/pd-5" });
  await db.insert(supplierStock).values({
    link: "https://dodavatel.example.com/pd-5",
    sizeLabel: "",
    host: "dodavatel.example.com",
    availability: "available",
    availabilityText: "Skladom u dodávateľa",
    source: "text",
    ok: true,
    checkedAt: new Date("2026-07-20T00:00:00Z"),
    confirmedAt: new Date("2026-07-20T00:00:00Z"),
  });

  const telo = (await (await app.request("/api/product-detail/PD-5", { headers: { cookie } })).json()) as DetailTelo;
  expect(telo.variants[0]?.supplierAvailability).toBe("available");
  expect(telo.variants[0]?.supplierAvailabilityText).toBe("Skladom u dodávateľa");
});

it("dostupnosť u dodávateľa PER VEĽKOSŤ — každý variant dostane svoj vlastný riadok, žiadne krížové zamiešanie", async () => {
  const { app, cookie, db } = await boot();
  const link = "https://dodavatel.example.com/pd-6";
  await insertTestVariantForProduct(db, "PD-6", "PD-6/S", { sizeLabel: "S", internalNote: link });
  await insertTestVariantForProduct(db, "PD-6", "PD-6/M", { sizeLabel: "M", internalNote: link });
  await db.insert(supplierStock).values([
    {
      link,
      sizeLabel: "S",
      host: "dodavatel.example.com",
      availability: "available",
      availabilityText: "Skladom (S)",
      source: "size_list",
      ok: true,
      checkedAt: new Date("2026-07-20T00:00:00Z"),
      confirmedAt: new Date("2026-07-20T00:00:00Z"),
    },
    {
      link,
      sizeLabel: "M",
      host: "dodavatel.example.com",
      availability: "unavailable",
      availabilityText: "Vypredané (M)",
      source: "size_list",
      ok: true,
      checkedAt: new Date("2026-07-20T00:00:00Z"),
      confirmedAt: new Date("2026-07-20T00:00:00Z"),
    },
  ]);

  const telo = (await (await app.request("/api/product-detail/PD-6", { headers: { cookie } })).json()) as DetailTelo;
  expect(telo.variants).toHaveLength(2);
  const s = telo.variants.find((v) => v.code === "PD-6/S");
  const m = telo.variants.find((v) => v.code === "PD-6/M");
  expect(s?.supplierAvailability).toBe("available");
  expect(m?.supplierAvailability).toBe("unavailable");
});
