import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { auditEvents, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { ingestCatalog, type CatalogIngestResult } from "../src/modules/catalog/ingest.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { DEFAULT_SNAPSHOT_LIMITS } from "../src/modules/catalog/validation.js";
import { withCleanDb } from "./helpers/db.js";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("../src/modules/catalog/fixtures/shoptet-sample.csv", import.meta.url)),
);
const TEST_LIMITS = { ...DEFAULT_SNAPSHOT_LIMITS, minByteSize: 1_000, absoluteMinRows: 10 };
const HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo
const NOW = new Date("2026-07-29T10:00:00Z");

let close: (() => Promise<void>) | undefined;
let rawDir: string | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  if (rawDir !== undefined) await rm(rawDir, { recursive: true, force: true });
  rawDir = undefined;
});

async function boot(options: { readonly role: "manazer" | "citanie"; readonly seed: boolean }) {
  const ctx = await withCleanDb();
  close = ctx.close;
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-http-"));
  const dir = rawDir;

  await ctx.db.insert(users).values({
    email: "manazer@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Manažér",
    role: options.role,
  });
  if (options.seed) {
    await ingestCatalog(ctx.db, {
      fetchExport: () => Promise.resolve({ body: FIXTURE, sourceLabel: "fixtúra" }),
      now: NOW,
      rawDir: dir,
      limits: TEST_LIMITS,
    });
  }

  const runIngest = (now: Date): Promise<CatalogIngestResult> =>
    ingestCatalog(ctx.db, {
      fetchExport: () => Promise.resolve({ body: FIXTURE, sourceLabel: "fixtúra" }),
      now,
      rawDir: dir,
      limits: TEST_LIMITS,
    });

  const app = createApp(ctx.db, { cookieSecure: false, runIngest });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db };
}

it("bez prihlásenia vráti 401 na každej trase katalógu", async () => {
  const { app } = await boot({ role: "manazer", seed: false });
  for (const path of ["/api/catalog/stats", "/api/catalog/snapshots", "/api/catalog/variants"]) {
    expect((await app.request(path)).status).toBe(401);
  }
});

it("vráti prehľad katalógu", async () => {
  const { app, cookie } = await boot({ role: "manazer", seed: true });
  const res = await app.request("/api/catalog/stats", { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    variantCount: 35,
    productCount: 8,
    sellable: 6,
    outOfStock: 4,
    discontinued: 25,
    missing: 0,
    lastSnapshot: { verdict: "accepted", rowCount: 35 },
  });
});

it("vyhľadá variant podľa kódu aj podľa názvu", async () => {
  const { app, cookie } = await boot({ role: "manazer", seed: true });

  const podlaKodu = await app.request("/api/catalog/variants?q=40237/3XL", { headers: { cookie } });
  const kodovy = (await podlaKodu.json()) as { total: number; items: { code: string }[] };
  expect(kodovy.total).toBe(1);
  expect(kodovy.items[0]?.code).toBe("40237/3XL");

  const podlaNazvu = await app.request("/api/catalog/variants?q=čiapka", { headers: { cookie } });
  const nazvovy = (await podlaNazvu.json()) as { total: number; items: { code: string }[] };
  expect(nazvovy.total).toBe(1);
  expect(nazvovy.items[0]?.code).toBe("40287");
});

it("filtruje podľa stavu a stránkuje", async () => {
  const { app, cookie } = await boot({ role: "manazer", seed: true });

  const skladom = await app.request("/api/catalog/variants?state=sellable", { headers: { cookie } });
  expect((await skladom.json()) as { total: number }).toMatchObject({ total: 6 });

  const strana = await app.request("/api/catalog/variants?pageSize=10&page=2", {
    headers: { cookie },
  });
  const druha = (await strana.json()) as { total: number; items: unknown[] };
  expect(druha.total).toBe(35);
  expect(druha.items).toHaveLength(10);
});

it("odmietne neplatný parameter stavu", async () => {
  const { app, cookie } = await boot({ role: "manazer", seed: true });
  expect((await app.request("/api/catalog/variants?state=hocico", { headers: { cookie } })).status).toBe(400);
});

it("vráti detail variantu a 404 pre neznámy kód", async () => {
  const { app, cookie } = await boot({ role: "manazer", seed: true });

  const detail = await app.request("/api/catalog/variants/40237%2F3XL", { headers: { cookie } });
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({
    code: "40237/3XL",
    productKey: "40237",
    sizeLabel: "3XL",
    price: "67.00",
    currency: "EUR",
    state: "discontinued",
    availabilityInStockText: "Predaj výrobku skončil",
  });

  expect((await app.request("/api/catalog/variants/NEEXISTUJE", { headers: { cookie } })).status).toBe(404);
});

it("vypíše snapshoty od najnovšieho", async () => {
  const { app, cookie } = await boot({ role: "manazer", seed: true });
  const res = await app.request("/api/catalog/snapshots?limit=5", { headers: { cookie } });
  const data = (await res.json()) as { items: { verdict: string; columnCount: number }[] };
  expect(data.items).toHaveLength(1);
  expect(data.items[0]).toMatchObject({ verdict: "accepted", columnCount: 265, variantCount: 35 });
});

it("ručný import spustí manažér a zapíše sa do auditu", async () => {
  const { app, cookie, db } = await boot({ role: "manazer", seed: false });

  const res = await app.request("/api/catalog/ingest", { method: "POST", headers: { cookie } });
  expect(res.status).toBe(200);
  expect((await res.json()) as { status: string }).toMatchObject({ status: "accepted" });

  const events = await db.select().from(auditEvents);
  expect(events.map((e) => e.action)).toContain("catalog.ingest.trigger");
});

it("rola citanie nesmie spustiť import", async () => {
  const { app, cookie } = await boot({ role: "citanie", seed: false });
  expect((await app.request("/api/catalog/ingest", { method: "POST", headers: { cookie } })).status).toBe(403);
});

it("bez nakonfigurovanej URL vráti import 503", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({
    email: "manazer@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Manažér",
    role: "manazer",
  });
  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect((await app.request("/api/catalog/ingest", { method: "POST", headers: { cookie } })).status).toBe(503);
});
