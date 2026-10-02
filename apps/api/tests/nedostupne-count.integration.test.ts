import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { orderLines, orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { setVariantResolved } from "../src/modules/nedostupne/resolved.js";
import { DEFAULT_ORDER_OPEN_STATUS } from "../src/modules/orders/open-statuses.js";
import { insertTestVariantForProduct } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 586: odznak „Nedostupné tovary" v ľavom menu = počet KARIET na
// obrazovke (jedna karta = jeden nedostupný variant v otvorenej objednávke).
// Vlastný súbor (eslint `max-lines: 400` — `nedostupne-http.integration.test.ts`
// je už na hranici). Kľúčová vlastnosť: počet a výpis idú TOU ISTOU dátovou
// cestou, takže odznak == dĺžka výpisu (vzor issue 514/516).
const HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot() {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({ email: "pouzivatel@forestshop.sk", passwordHash: await hashPassword(HESLO), displayName: "Test", role: "citanie" });
  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "pouzivatel@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db };
}

type Db = Awaited<ReturnType<typeof boot>>["db"];

async function seedLine(db: Db, orderCode: string, variantCode: string, options: { readonly statusName?: string; readonly state?: "nedostupne" | "objednane" } = {}): Promise<string> {
  const [order] = await db
    .insert(orders)
    .values({
      externalOrderId: orderCode,
      customerName: "Zákazník Test",
      statusName: options.statusName ?? DEFAULT_ORDER_OPEN_STATUS,
      placedAt: new Date("2026-07-20T10:00:00Z"),
      email: "zakaznik@example.sk",
    })
    .returning({ id: orders.id });
  if (order === undefined) throw new Error("test objednávka sa nepodarilo vložiť");
  await db.insert(orderLines).values({ orderId: order.id, variantCode, quantity: 1, state: options.state ?? "nedostupne" });
  return order.id;
}

async function readCountAndList(app: Awaited<ReturnType<typeof boot>>["app"], cookie: string): Promise<{ count: number; groups: number }> {
  const countRes = await app.request("/api/nedostupne/count", { headers: { cookie } });
  expect(countRes.status).toBe(200);
  const { count } = (await countRes.json()) as { count: number };
  const listRes = await app.request("/api/nedostupne", { headers: { cookie } });
  const { groups } = (await listRes.json()) as { groups: readonly unknown[] };
  return { count, groups: groups.length };
}

it("GET /api/nedostupne/count bez prihlásenia vráti 401", async () => {
  const { app } = await boot();
  const res = await app.request("/api/nedostupne/count");
  expect(res.status).toBe(401);
});

it("prázdna databáza = 0 (odznak sa nekreslí)", async () => {
  const { app, cookie } = await boot();
  expect(await readCountAndList(app, cookie)).toEqual({ count: 0, groups: 0 });
});

it("počíta KARTY (distinct variant), nie objednávky ani riadky — a rovná sa dĺžke výpisu", async () => {
  const { app, cookie, db } = await boot();
  await insertTestVariantForProduct(db, "N586A-key", "N586A", { productName: "Test A" });
  await insertTestVariantForProduct(db, "N586B-key", "N586B", { productName: "Test B" });
  // Variant A čaká v DVOCH objednávkach — stále JEDNA karta.
  await seedLine(db, "58600001", "N586A");
  await seedLine(db, "58600002", "N586A");
  await seedLine(db, "58600003", "N586B");

  expect(await readCountAndList(app, cookie)).toEqual({ count: 2, groups: 2 });
});

it("vybavené sa nepočíta: zatvorená objednávka aj riadok mimo stavu 'nedostupne' vypadnú z počtu aj z výpisu", async () => {
  const { app, cookie, db } = await boot();
  await insertTestVariantForProduct(db, "N586C-key", "N586C", { productName: "Test C" });
  await insertTestVariantForProduct(db, "N586D-key", "N586D", { productName: "Test D" });
  await insertTestVariantForProduct(db, "N586E-key", "N586E", { productName: "Test E" });
  await seedLine(db, "58600011", "N586C"); // aktívna karta
  await seedLine(db, "58600012", "N586D", { statusName: "Vybavená" }); // objednávka už nie je otvorená
  const objednane = await seedLine(db, "58600013", "N586E");
  expect(await readCountAndList(app, cookie)).toEqual({ count: 2, groups: 2 });

  // Riadok obsluha prepne z „nedostupné" na „objednané" — karta zmizne z výpisu aj z odznaku.
  await db.update(orderLines).set({ state: "objednane" }).where(eq(orderLines.orderId, objednane));
  expect(await readCountAndList(app, cookie)).toEqual({ count: 1, groups: 1 });
});

it("karta s ručným checkboxom „vyriešené“ (issue 531) ostáva vo výpise, preto sa aj počíta (odznak == výpis)", async () => {
  const { app, cookie, db } = await boot();
  await insertTestVariantForProduct(db, "N586F-key", "N586F", { productName: "Test F" });
  await insertTestVariantForProduct(db, "N586G-key", "N586G", { productName: "Test G" });
  await seedLine(db, "58600021", "N586F");
  await seedLine(db, "58600022", "N586G");
  await setVariantResolved(db, "N586F", true, new Date("2026-10-02T08:00:00Z"));

  expect(await readCountAndList(app, cookie)).toEqual({ count: 2, groups: 2 });
});
