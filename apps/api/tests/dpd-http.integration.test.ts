import { afterEach, expect, it } from "vitest";
import { dpdShipments, orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import type { DpdRunDeps } from "../src/http/dpd-routes.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { dpdPortalConfigFromBaseUrl } from "../src/modules/dpd/config.js";
import { withCleanDb } from "./helpers/db.js";

// issue 292: HTTP vrstva "Eshop → Preprava DPD". `createShipment`/
// `orderPickup` sú VŽDY falošné implementácie (`DpdRunDeps`'s injektované
// funkcie) — appka NIKDY nespustí skutočný Chromium ani sa nedotkne
// reálneho DPD účtu z testu, rovnaká bezpečnostná podmienka ako pri
// Shoptet-e (`.claude/rules/dpd.md`).
const HESLO = "test-heslo-abc";
const FAKE_CONFIG = dpdPortalConfigFromBaseUrl("https://dpd.example.invalid", "u", "p");

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot(role: UserRole, deps: DpdRunDeps = { config: undefined }) {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({
    email: "pouzivatel@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Test",
    role,
  });
  const app = createApp(ctx.db, { cookieSecure: false, dpd: deps });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "pouzivatel@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db };
}

const NEW_ORDER = {
  externalOrderId: "20700001",
  customerName: "Ján Novák",
  statusName: "Vybavuje sa",
  placedAt: new Date("2026-08-01T10:00:00Z"),
  phone: "+421900123456",
  deliveryFullName: "Ján Novák",
  deliveryStreet: "Hlavná",
  deliveryHouseNumber: "12",
  deliveryCity: "Poprad",
  deliveryZip: "05801",
  deliveryCountryName: "Slovensko",
  weight: "1.50",
  paymentMethodName: "Dobierka (hotovosť) + karta (len SR)",
  priceToPay: "32.50",
  totalPriceWithVat: "32.50",
};

it("GET /api/dpd/orders bez prihlásenia vráti 401", async () => {
  const { app } = await boot("manazer");
  const res = await app.request("/api/dpd/orders");
  expect(res.status).toBe(401);
});

it("GET /api/dpd/orders vráti configured:false, keď appka nemá DPD prihlasovacie údaje", async () => {
  const { app, cookie } = await boot("manazer");
  const res = await app.request("/api/dpd/orders", { headers: { cookie } });
  const body = (await res.json()) as { configured: boolean };
  expect(body.configured).toBe(false);
});

it("GET /api/dpd/orders vylúči objednávku s package_number aj s úspešnou dpd_shipment, ale zahrnie zlyhanú", async () => {
  const { app, cookie, db } = await boot("manazer");
  const [order1] = await db.insert(orders).values({ ...NEW_ORDER, externalOrderId: "20700001" }).returning({ id: orders.id });
  const [order2] = await db.insert(orders).values({ ...NEW_ORDER, externalOrderId: "20700002", packageNumber: "EF123SK" }).returning({ id: orders.id });
  const [order3] = await db.insert(orders).values({ ...NEW_ORDER, externalOrderId: "20700003" }).returning({ id: orders.id });
  const [order4] = await db.insert(orders).values({ ...NEW_ORDER, externalOrderId: "20700004" }).returning({ id: orders.id });
  await db.insert(dpdShipments).values({
    orderId: order3?.id as string,
    status: "submitted",
    weightKg: "1.50",
    parcelNumber: "06565000000001",
  });
  await db.insert(dpdShipments).values({
    orderId: order4?.id as string,
    status: "failed",
    weightKg: "1.50",
    errorMessage: "portál nedostupný",
  });

  const res = await app.request("/api/dpd/orders", { headers: { cookie } });
  const body = (await res.json()) as { orders: { preview: { externalOrderId: string }; lastFailure: string | null }[] };
  const externalIds = body.orders.map((o) => o.preview.externalOrderId).sort();
  expect(externalIds).toEqual(["20700001", "20700004"]);
  expect(order1).toBeDefined();
  expect(order2).toBeDefined();
  const failed = body.orders.find((o) => o.preview.externalOrderId === "20700004");
  expect(failed?.lastFailure).toBe("portál nedostupný");
  const pending = body.orders.find((o) => o.preview.externalOrderId === "20700001");
  expect(pending?.lastFailure).toBeNull();
});

it("POST /api/dpd/preview vypočíta náhľad pre zvolené objednávky s obsluhou upravenou hmotnosťou", async () => {
  const { app, cookie, db } = await boot("manazer");
  const [order1] = await db.insert(orders).values(NEW_ORDER).returning({ id: orders.id });
  const orderId = order1?.id as string;

  const res = await app.request("/api/dpd/preview", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderIds: [orderId], weightOverrides: { [orderId]: "3.20" } }),
  });
  const body = (await res.json()) as { previews: { orderId: string; weightKg: string; isCod: boolean; codAmount: string | null }[] };
  expect(body.previews).toHaveLength(1);
  expect(body.previews[0]).toMatchObject({ orderId, weightKg: "3.20", isCod: true, codAmount: "32.50" });
});

it("POST /api/dpd/shipments vráti 503, keď appka nemá DPD prihlasovacie údaje", async () => {
  const { app, cookie, db } = await boot("manazer");
  const [order1] = await db.insert(orders).values(NEW_ORDER).returning({ id: orders.id });
  const res = await app.request("/api/dpd/shipments", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderIds: [order1?.id] }),
  });
  expect(res.status).toBe(503);
});

it("POST /api/dpd/shipments preskočí objednávku s neúplnou adresou bez volania robota", async () => {
  let called = false;
  const { app, cookie, db } = await boot("manazer", {
    config: FAKE_CONFIG,
    createShipment: () => {
      called = true;
      return Promise.resolve({ ok: true, parcelNumber: "06565000000099", errorDetail: null });
    },
  });
  const [order1] = await db.insert(orders).values({ ...NEW_ORDER, deliveryStreet: null }).returning({ id: orders.id });

  const res = await app.request("/api/dpd/shipments", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderIds: [order1?.id] }),
  });
  const body = (await res.json()) as { results: { orderId: string; ok: boolean; error?: string }[] };
  expect(called).toBe(false);
  expect(body.results[0]).toMatchObject({ ok: false, error: "Chýba doručovacia adresa" });
});

it("POST /api/dpd/shipments zapíše úspech s číslom zásielky a jedna zlyhaná objednávka neovplyvní druhú", async () => {
  const { app, cookie, db } = await boot("manazer", {
    config: FAKE_CONFIG,
    createShipment: (options) =>
      Promise.resolve(
        options.shipment.externalOrderId === "20700001"
          ? { ok: true, parcelNumber: "06565000000042", errorDetail: null }
          : { ok: false, parcelNumber: null, errorDetail: "DPD formulár /shipments/0 ešte nie je naživo domapovaný" },
      ),
  });
  const [order1] = await db.insert(orders).values({ ...NEW_ORDER, externalOrderId: "20700001" }).returning({ id: orders.id });
  const [order2] = await db.insert(orders).values({ ...NEW_ORDER, externalOrderId: "20700002" }).returning({ id: orders.id });

  const res = await app.request("/api/dpd/shipments", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderIds: [order1?.id, order2?.id] }),
  });
  const body = (await res.json()) as { results: { orderId: string; ok: boolean; parcelNumber?: string; error?: string }[] };
  const success = body.results.find((r) => r.orderId === order1?.id);
  const failure = body.results.find((r) => r.orderId === order2?.id);
  expect(success).toMatchObject({ ok: true, parcelNumber: "06565000000042" });
  expect(failure?.ok).toBe(false);

  const shipmentRows = await db.select().from(dpdShipments);
  const successRow = shipmentRows.find((r) => r.orderId === order1?.id);
  const failureRow = shipmentRows.find((r) => r.orderId === order2?.id);
  expect(successRow).toMatchObject({ status: "submitted", parcelNumber: "06565000000042" });
  expect(failureRow?.status).toBe("failed");

  // GET /api/dpd/orders už neukáže úspešne odoslanú objednávku.
  const listRes = await app.request("/api/dpd/orders", { headers: { cookie } });
  const listBody = (await listRes.json()) as { orders: { preview: { externalOrderId: string } }[] };
  expect(listBody.orders.map((o) => o.preview.externalOrderId)).toEqual(["20700002"]);
});

it("POST /api/dpd/pickup-orders zapíše pokus a vráti 503, keď nie je nakonfigurované", async () => {
  const { app, cookie, db } = await boot("manazer");
  const res = await app.request("/api/dpd/pickup-orders", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ pickupDate: "2026-08-10" }),
  });
  expect(res.status).toBe(503);
  void db;
});

it("POST /api/dpd/pickup-orders zapíše úspešný pokus, keď je nakonfigurované", async () => {
  const { app, cookie, db } = await boot("manazer", {
    config: FAKE_CONFIG,
    orderPickup: () => Promise.resolve({ ok: true, errorDetail: null }),
  });
  const res = await app.request("/api/dpd/pickup-orders", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ pickupDate: "2026-08-10" }),
  });
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(true);
  const { dpdPickupRequests } = await import("../src/db/schema.js");
  const rows = await db.select().from(dpdPickupRequests);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "submitted", pickupDate: "2026-08-10" });
});

it("nemanažér/citanie nemôže odoslať zásielku (403)", async () => {
  const { app, cookie, db } = await boot("citanie", { config: FAKE_CONFIG });
  const [order1] = await db.insert(orders).values(NEW_ORDER).returning({ id: orders.id });
  const res = await app.request("/api/dpd/shipments", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderIds: [order1?.id] }),
  });
  expect(res.status).toBe(403);
});

// issue 445: stavový filter — kvalifikujú len OTVORENÉ objednávky (znovupoužitý
// `order_open_status` mechanizmus, default "Vybavuje sa"). Terminálne stavy
// ("Stornovaná"/"Vybavená"/"Vratený tovar"/...) sa NIKDY neponúkajú, aj keď
// nemajú `package_number` ani odoslanú `dpd_shipment` — presne šéfova výhrada
// (priveľa objednávok s DPD možnosťou). Regression: PRED fixom (žiadny stavový
// filter) by tento test padol, lebo aj terminálne objednávky sa ponúkli.
it("GET /api/dpd/orders vylúči terminálne stavy (Stornovaná/Vybavená/Vratený tovar), aj bez package_number a dpd_shipment", async () => {
  const { app, cookie, db } = await boot("manazer");
  await db.insert(orders).values({ ...NEW_ORDER, externalOrderId: "20700010", statusName: "Vybavuje sa" });
  await db.insert(orders).values({ ...NEW_ORDER, externalOrderId: "20700011", statusName: "Stornovaná" });
  await db.insert(orders).values({ ...NEW_ORDER, externalOrderId: "20700012", statusName: "Vybavená" });
  await db.insert(orders).values({ ...NEW_ORDER, externalOrderId: "20700013", statusName: "Vratený tovar" });

  const res = await app.request("/api/dpd/orders", { headers: { cookie } });
  const body = (await res.json()) as { orders: { preview: { externalOrderId: string } }[] };
  const externalIds = body.orders.map((o) => o.preview.externalOrderId).sort();
  expect(externalIds).toEqual(["20700010"]);
});

it("GET /api/dpd/orders/count bez prihlásenia vráti 401", async () => {
  const { app } = await boot("manazer");
  const res = await app.request("/api/dpd/orders/count");
  expect(res.status).toBe(401);
});

// issue 445: nav badge — počet MUSÍ sedieť s dĺžkou (filtrovaného) zoznamu.
it("GET /api/dpd/orders/count vráti počet zhodný s filtrovaným zoznamom (bez terminálnych, bez package_number)", async () => {
  const { app, cookie, db } = await boot("manazer");
  await db.insert(orders).values({ ...NEW_ORDER, externalOrderId: "20700020", statusName: "Vybavuje sa" });
  await db.insert(orders).values({ ...NEW_ORDER, externalOrderId: "20700021", statusName: "Vybavuje sa" });
  await db.insert(orders).values({ ...NEW_ORDER, externalOrderId: "20700022", statusName: "Stornovaná" });
  await db.insert(orders).values({ ...NEW_ORDER, externalOrderId: "20700023", packageNumber: "EF999SK" });

  const countRes = await app.request("/api/dpd/orders/count", { headers: { cookie } });
  const countBody = (await countRes.json()) as { count: number };
  expect(countBody.count).toBe(2);

  const listRes = await app.request("/api/dpd/orders", { headers: { cookie } });
  const listBody = (await listRes.json()) as { orders: unknown[] };
  expect(countBody.count).toBe(listBody.orders.length);
});
