import { afterEach, describe, expect, it } from "vitest";
import { orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { withCleanDb } from "./helpers/db.js";

// issue 345: HTTP vrstva pre "Eshop → Objednávky predajňa" — vlastný súbor
// (rovnaký dôvod ako `order-flags-http.integration.test.ts`, eslint
// `max-lines: 400`).
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
    .values({ email: "pouzivatel@forestshop.sk", passwordHash: await hashPassword(HESLO), displayName: "Test", role })
    .returning({ id: users.id });
  if (pouzivatel === undefined) throw new Error("testovací používateľ sa nepodarilo vložiť");
  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "pouzivatel@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db };
}

let poradie = 0;
async function insertOrder(
  db: Awaited<ReturnType<typeof boot>>["db"],
  options: {
    readonly shippingCarrierName?: string | null;
    readonly placedAt?: Date;
    readonly customerName?: string;
  } = {},
): Promise<{ id: string; externalOrderId: string }> {
  poradie += 1;
  const externalOrderId = `8${String(poradie).padStart(5, "0")}`;
  // `??` by prepadol cez explicitný `null` na default (JS past — `null ?? x`
  // vráti `x`, nie `null`), preto `"shippingCarrierName" in options`
  // namiesto `?? default`, aby test "bez dopravy" naozaj vložil `null`.
  const shippingCarrierName =
    "shippingCarrierName" in options ? (options.shippingCarrierName ?? null) : "Osobný odber - len na predajni v POPRADE!";
  const [order] = await db
    .insert(orders)
    .values({
      externalOrderId,
      customerName: options.customerName ?? "Zákazník testovaný",
      statusName: "Vybavená",
      shippingCarrierName,
      placedAt: options.placedAt ?? new Date("2026-07-20T00:00:00Z"),
      totalPriceWithVat: "42.00",
    })
    .returning({ id: orders.id, externalOrderId: orders.externalOrderId });
  if (order === undefined) throw new Error("insert objednávky zlyhal");
  return order;
}

describe("GET /api/floor-orders", () => {
  it("vráti len objednávky s 'Osobný odber' v spôsobe dopravy, podreťazcovo a case-insensitive", async () => {
    const { app, cookie, db } = await boot("citanie");
    const predajna = await insertOrder(db, { shippingCarrierName: "OSOBNÝ ODBER" });
    await insertOrder(db, { shippingCarrierName: "Kuriér" }); // iná doprava — nesmie sa objaviť
    await insertOrder(db, { shippingCarrierName: null }); // bez dopravy — nesmie sa objaviť

    const res = await app.request("/api/floor-orders", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; items: readonly Record<string, unknown>[] };
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.["externalOrderId"]).toBe(predajna.externalOrderId);
  });

  it("prežije zmenu textu v Shoptete — hľadá sa podreťazec, nie presná veta", async () => {
    const { app, cookie, db } = await boot("citanie");
    await insertOrder(db, { shippingCarrierName: "Osobný odber - úplne iný text ako predtým" });

    const res = await app.request("/api/floor-orders", { headers: { cookie } });
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(1);
  });

  it("zoradí najnovšie hore", async () => {
    const { app, cookie, db } = await boot("citanie");
    const starsia = await insertOrder(db, { placedAt: new Date("2026-07-01T00:00:00Z") });
    const novsia = await insertOrder(db, { placedAt: new Date("2026-07-10T00:00:00Z") });

    const res = await app.request("/api/floor-orders", { headers: { cookie } });
    const body = (await res.json()) as { items: readonly Record<string, unknown>[] };
    expect(body.items.map((i) => i["externalOrderId"])).toEqual([novsia.externalOrderId, starsia.externalOrderId]);
  });

  // review finding (issue 345): `placedAt` má len minútovú presnosť
  // (Shoptet export) — bez tie-breakera (`desc(orders.id)`) by LIMIT/OFFSET
  // pri dvoch objednávkach v TEJ ISTEJ minúte mohol byť nedeterministický
  // (riadok sa zopakuje na druhej strane, alebo sa stratí).
  it("dve objednávky s presne rovnakým 'placedAt' sa pri stránkovaní po jednej nikdy nezopakujú ani nestratia", async () => {
    const { app, cookie, db } = await boot("citanie");
    const rovnakyCas = new Date("2026-07-15T09:00:00Z");
    const a = await insertOrder(db, { placedAt: rovnakyCas });
    const b = await insertOrder(db, { placedAt: rovnakyCas });

    const prva = await app.request("/api/floor-orders?page=1&pageSize=1", { headers: { cookie } });
    const prvaBody = (await prva.json()) as { items: readonly Record<string, unknown>[] };
    const druha = await app.request("/api/floor-orders?page=2&pageSize=1", { headers: { cookie } });
    const druhaBody = (await druha.json()) as { items: readonly Record<string, unknown>[] };

    const videneIds = [prvaBody.items[0]?.["externalOrderId"], druhaBody.items[0]?.["externalOrderId"]];
    expect(videneIds.sort()).toEqual([a.externalOrderId, b.externalOrderId].sort());
  });

  it("stránkuje podľa page/pageSize, total počíta CELÚ odfiltrovanú množinu", async () => {
    const { app, cookie, db } = await boot("citanie");
    for (let i = 0; i < 5; i += 1) {
      await insertOrder(db, { placedAt: new Date(2026, 6, 1 + i) });
    }

    const prva = await app.request("/api/floor-orders?page=1&pageSize=2", { headers: { cookie } });
    const prvaBody = (await prva.json()) as { total: number; items: readonly unknown[] };
    expect(prvaBody.total).toBe(5);
    expect(prvaBody.items).toHaveLength(2);

    const druha = await app.request("/api/floor-orders?page=2&pageSize=2", { headers: { cookie } });
    const druhaBody = (await druha.json()) as { total: number; items: readonly unknown[] };
    expect(druhaBody.items).toHaveLength(2);

    const tretia = await app.request("/api/floor-orders?page=3&pageSize=2", { headers: { cookie } });
    const tretiaBody = (await tretia.json()) as { total: number; items: readonly unknown[] };
    expect(tretiaBody.items).toHaveLength(1);
  });

  it("obsahuje odkaz do Shoptet administrácie", async () => {
    const { app, cookie, db } = await boot("citanie");
    const objednavka = await insertOrder(db);

    const res = await app.request("/api/floor-orders", { headers: { cookie } });
    const body = (await res.json()) as { items: readonly Record<string, unknown>[] };
    expect(body.items[0]?.["adminUrl"]).toContain(objednavka.externalOrderId);
  });

  it("bez prihlásenia vráti 401", async () => {
    const { app } = await boot("manazer");
    const res = await app.request("/api/floor-orders");
    expect(res.status).toBe(401);
  });
});
