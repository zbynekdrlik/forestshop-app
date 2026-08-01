import { expect, it } from "vitest";
import { afterEach } from "vitest";
import { orderLines, orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// Testy pre issue 65 (zákaznícky odkaz `remark` + priamy odkaz do Shoptet
// administrácie `adminUrl` na `GET /api/orders/open`) — VLASTNÝ súbor,
// rovnaký dôvod ako `orders-http-comment.integration.test.ts`/`orders-http
// -ordered.integration.test.ts` (eslint `max-lines: 400`, `orders-http
// .integration.test.ts` je už na hranici, `.claude/rules/testing.md`).

const HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot(role: UserRole, adminBaseUrl?: string) {
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
    ...(adminBaseUrl === undefined ? {} : { adminBaseUrl }),
  });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db };
}

it("vráti zákaznícky odkaz (remark) pri riadku, null keď nie je vyplnený", async () => {
  const { app, cookie, db } = await boot("citanie");
  await insertTestVariant(db, "REM-1", "Dodávateľ Odkaz");
  await insertTestVariant(db, "REM-2", "Dodávateľ Odkaz");

  const [sOdkazom] = await db
    .insert(orders)
    .values({
      externalOrderId: "7001",
      customerName: "Zákazník s odkazom",
      remark: "Prosím doručiť len v piatok",
      placedAt: new Date("2026-07-10T00:00:00Z"),
    })
    .returning();
  if (sOdkazom === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: sOdkazom.id, variantCode: "REM-1", quantity: 1 });

  const [bezOdkazu] = await db
    .insert(orders)
    .values({ externalOrderId: "7002", customerName: "Zákazník bez odkazu", placedAt: new Date("2026-07-11T00:00:00Z") })
    .returning();
  if (bezOdkazu === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: bezOdkazu.id, variantCode: "REM-2", quantity: 1 });

  const res = await app.request("/api/orders/open", { headers: { cookie } });
  const telo = (await res.json()) as {
    suppliers: { lines: { externalOrderId: string; remark: string | null }[] }[];
  };
  const lines = telo.suppliers.flatMap((s) => s.lines);
  expect(lines.find((l) => l.externalOrderId === "7001")?.remark).toBe("Prosím doručiť len v piatok");
  expect(lines.find((l) => l.externalOrderId === "7002")?.remark).toBeNull();
});

// issue 164: interná poznámka e-shopu (`order.shop_remark`, SUROVÁ v DB) sa
// na `GET /api/orders/open` vracia ROZDELENÁ — appkin vlastný blok
// (`note-block.ts`'s oddeľovače) sa NIKDY nezobrazí, len cudzí (ručne
// napísaný) text okolo neho. Appkina VLASTNÁ poznámka (`comment`) ostáva
// nezávislé pole, nemení sa touto extrakciou.
it("vráti internú poznámku e-shopu BEZ nášho vlastného bloku — len cudzí text", async () => {
  const { app, cookie, db } = await boot("citanie");
  await insertTestVariant(db, "SHOP-1", "Dodávateľ Shop");
  await insertTestVariant(db, "SHOP-2", "Dodávateľ Shop");
  await insertTestVariant(db, "SHOP-3", "Dodávateľ Shop");

  const [sCudzimTextom] = await db
    .insert(orders)
    .values({
      externalOrderId: "7003",
      customerName: "Zákazník A",
      shopRemark:
        "Ručná poznámka predajne\n\n--- poznámka z appky ---\nNaša poznámka\n--- koniec ---",
      placedAt: new Date("2026-07-12T00:00:00Z"),
    })
    .returning();
  if (sCudzimTextom === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: sCudzimTextom.id, variantCode: "SHOP-1", quantity: 1 });

  const [lenNasBlok] = await db
    .insert(orders)
    .values({
      externalOrderId: "7004",
      customerName: "Zákazník B",
      shopRemark: "--- poznámka z appky ---\nNaša poznámka\n--- koniec ---",
      placedAt: new Date("2026-07-13T00:00:00Z"),
    })
    .returning();
  if (lenNasBlok === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: lenNasBlok.id, variantCode: "SHOP-2", quantity: 1 });

  const [bezPoznamky] = await db
    .insert(orders)
    .values({ externalOrderId: "7005", customerName: "Zákazník C", placedAt: new Date("2026-07-14T00:00:00Z") })
    .returning();
  if (bezPoznamky === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: bezPoznamky.id, variantCode: "SHOP-3", quantity: 1 });

  const res = await app.request("/api/orders/open", { headers: { cookie } });
  const telo = (await res.json()) as {
    suppliers: { lines: { externalOrderId: string; shopRemark: string | null }[] }[];
  };
  const lines = telo.suppliers.flatMap((s) => s.lines);
  expect(lines.find((l) => l.externalOrderId === "7003")?.shopRemark).toBe("Ručná poznámka predajne");
  expect(lines.find((l) => l.externalOrderId === "7004")?.shopRemark).toBeNull();
  expect(lines.find((l) => l.externalOrderId === "7005")?.shopRemark).toBeNull();
});

// issue 65: `adminUrl` je odvodený zo servera (`SHOPTET_ADMIN_BASE_URL`
// premennej, `env.ts`) + kódu objednávky — over aj to, že sa naozaj vezme
// nakonfigurovaná doména (nie natvrdo v kóde), aj to, že kód objednávky sa
// escapuje (`encodeURIComponent`).
it("vráti priamy odkaz do Shoptet administrácie pri riadku, zložený z nakonfigurovanej domény + kódu objednávky", async () => {
  const { app, cookie, db } = await boot("manazer", "https://admin.example.sk");
  await insertTestVariant(db, "ADM-1", "Dodávateľ Admin");

  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "7003 & test", customerName: "Zákazník", placedAt: new Date("2026-07-12T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "ADM-1", quantity: 1 });

  const res = await app.request("/api/orders/open", { headers: { cookie } });
  const telo = (await res.json()) as { suppliers: { lines: { externalOrderId: string; adminUrl: string }[] }[] };
  const line = telo.suppliers.flatMap((s) => s.lines).find((l) => l.externalOrderId === "7003 & test");
  expect(line?.adminUrl).toBe(
    "https://admin.example.sk/admin/vyhladavanie/?string=7003%20%26%20test&src=orders",
  );
});

// issue 120: keď appka POZNÁ interné Shoptet id objednávky (`shoptet_order_
// id`, naplnené XML obohatením v `ingest.ts`), odkaz ide PRIAMO na detail
// objednávky, nie na vyhľadávanie — presne to, čo majiteľ v tickete žiadal.
it("keď je známe interné Shoptet id, odkaz ide priamo na objednavky-detail namiesto vyhľadávania", async () => {
  const { app, cookie, db } = await boot("manazer", "https://admin.example.sk");
  await insertTestVariant(db, "ADM-2", "Dodávateľ Admin");

  const [objednavka] = await db
    .insert(orders)
    .values({
      externalOrderId: "7004",
      customerName: "Zákazník",
      placedAt: new Date("2026-07-13T00:00:00Z"),
      shoptetOrderId: 58728,
    })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "ADM-2", quantity: 1 });

  const res = await app.request("/api/orders/open", { headers: { cookie } });
  const telo = (await res.json()) as { suppliers: { lines: { externalOrderId: string; adminUrl: string }[] }[] };
  const line = telo.suppliers.flatMap((s) => s.lines).find((l) => l.externalOrderId === "7004");
  expect(line?.adminUrl).toBe("https://admin.example.sk/admin/objednavky-detail/?id=58728");
});
