import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { auditEvents, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { ingestCatalog, type CatalogIngestResult } from "../src/modules/catalog/ingest.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { DEFAULT_SNAPSHOT_LIMITS } from "../src/modules/catalog/validation.js";
import { withCleanDb } from "./helpers/db.js";

// Testy pre `POST /api/catalog/ingest` — trigger, rola, pôvod požiadavky,
// audit a súbežnosť. Vydelené z `catalog-http.integration.test.ts` (ktorý
// pokrýva čítacie trasy katalógu), aby ani jeden zo súborov nenarástol cez
// limit 400 riadkov (eslint `max-lines`).

const FIXTURE = readFileSync(
  fileURLToPath(new URL("../src/modules/catalog/fixtures/shoptet-sample.csv", import.meta.url)),
);
const TEST_LIMITS = { ...DEFAULT_SNAPSHOT_LIMITS, minByteSize: 1_000, absoluteMinRows: 10 };
const HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo

let close: (() => Promise<void>) | undefined;
let rawDir: string | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  if (rawDir !== undefined) await rm(rawDir, { recursive: true, force: true });
  rawDir = undefined;
  // Pozri rovnaký komentár v catalog-http.integration.test.ts — bez tohto sa
  // POST /api/login počítadlo hromadí naprieč testami v súbore.
  resetLoginRateLimit();
});

async function boot(role: UserRole) {
  const ctx = await withCleanDb();
  close = ctx.close;
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-http-ingest-"));
  const dir = rawDir;

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
  return { app, cookie, db: ctx.db, userId: pouzivatel.id };
}

it("ručný import spustí manažér a zapíše sa do auditu so skutočným výsledkom", async () => {
  const { app, cookie, db, userId } = await boot("manazer");

  const res = await app.request("/api/catalog/ingest", { method: "POST", headers: { cookie } });
  expect(res.status).toBe(200);
  const telo = (await res.json()) as { status: string; snapshotId: string };
  expect(telo).toMatchObject({ status: "accepted" });

  // Nestačí, že akcia bola zapísaná — musí niesť AJ pôvodcu (nie len reťazec
  // akcie, čo by prešlo aj bez skutočného aktéra), AJ výsledok importu, nielen
  // úmysel ho spustiť (review task-6-fix-1).
  const udalosti = await db.select().from(auditEvents);
  const udalost = udalosti.find((e) => e.action === "catalog.ingest.trigger");
  expect(udalost).toBeDefined();
  expect(udalost?.actorUserId).toBe(userId);
  expect(udalost?.data).toMatchObject({ status: "accepted", snapshotId: telo.snapshotId });
});

it("rola citanie nesmie spustiť import", async () => {
  const { app, cookie } = await boot("citanie");
  expect((await app.request("/api/catalog/ingest", { method: "POST", headers: { cookie } })).status).toBe(403);
});

it("rola sef tiež nesmie spustiť import — obe neprivilegované role sú overené, nielen jedna", async () => {
  const { app, cookie } = await boot("sef");
  expect((await app.request("/api/catalog/ingest", { method: "POST", headers: { cookie } })).status).toBe(403);
});

it("import s cudzím Origin je odmietnutý (403), rovnaký pôvod aj bez hlavičiek prejde", async () => {
  const { app, cookie } = await boot("manazer");

  const cudzi = await app.request("/api/catalog/ingest", {
    method: "POST",
    headers: { cookie, origin: "https://utocnik.example", host: "forestshop.example" },
  });
  expect(cudzi.status).toBe(403);

  const rovnaky = await app.request("/api/catalog/ingest", {
    method: "POST",
    headers: { cookie, origin: "https://forestshop.example", host: "forestshop.example" },
  });
  expect(rovnaky.status).toBe(200);
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

it("druhý import rovnakých bajtov je duplicate, nikdy chyba", async () => {
  const { app, cookie } = await boot("manazer");

  const prvy = await app.request("/api/catalog/ingest", { method: "POST", headers: { cookie } });
  expect(prvy.status).toBe(200);
  expect((await prvy.json()) as { status: string }).toMatchObject({ status: "accepted" });

  const druhy = await app.request("/api/catalog/ingest", { method: "POST", headers: { cookie } });
  expect(druhy.status).toBe(200);
  expect((await druhy.json()) as { status: string }).toMatchObject({ status: "duplicate" });
});

it("import exportu, ktorý sa nedá prečítať, je normálna 200 odpoveď so statusom rejected, nie chyba", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-http-ingest-"));
  const dir = rawDir;
  await ctx.db.insert(users).values({
    email: "manazer@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Manažér",
    role: "manazer",
  });
  // Zacitovaná bunka, ktorá sa nikdy nezatvorí — presne prípad, na ktorý
  // `parseDelimited` (csv.ts) vyhadzuje: pretrhnuté/nečitateľné stiahnutie.
  const nedaSaPrecitat = Buffer.from('code;name\r\n"nezatvorena bunka', "utf8");
  const runIngest = (now: Date): Promise<CatalogIngestResult> =>
    ingestCatalog(ctx.db, {
      fetchExport: () => Promise.resolve({ body: nedaSaPrecitat, sourceLabel: "poškodený export" }),
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

  const res = await app.request("/api/catalog/ingest", { method: "POST", headers: { cookie } });
  expect(res.status).toBe(200);
  expect((await res.json()) as { status: string }).toMatchObject({ status: "rejected" });
});

it("druhé súbežné spustenie importu vráti busy namiesto paralelného behu", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({
    email: "manazer@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Manažér",
    role: "manazer",
  });

  // Vlastný `runIngest`, ktorého dobehnutie riadi test — nie skutočný
  // `ingestCatalog`, aby súbežnosť nezávisela od časovania reálnych DB
  // dopytov (čo by test urobilo krehkým/flaky).
  let volani = 0;
  let dokonci: ((result: CatalogIngestResult) => void) | undefined;
  const runIngest = (): Promise<CatalogIngestResult> => {
    volani += 1;
    return new Promise((resolve) => {
      dokonci = resolve;
    });
  };

  const app = createApp(ctx.db, { cookieSecure: false, runIngest });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const prvyPromise = app.request("/api/catalog/ingest", { method: "POST", headers: { cookie } });
  // Počkaj, kým prvá požiadavka SKUTOČNE zavolá `runIngest` — vtedy už má
  // handler nastavené `ingestInFlight = true` (nastavuje sa tesne pred týmto
  // volaním), takže druhá požiadavka musí dostať "busy" deterministicky, bez
  // spoliehania sa na časovanie DB dopytov v middleware reťazci.
  await vi.waitFor(() => {
    if (volani < 1) throw new Error("runIngest ešte nebolo zavolané");
  });

  const druhy = await app.request("/api/catalog/ingest", { method: "POST", headers: { cookie } });
  expect(druhy.status).toBe(200);
  expect((await druhy.json()) as { status: string }).toEqual({ status: "busy" });

  dokonci?.({
    status: "accepted",
    snapshotId: "11111111-1111-1111-1111-111111111111",
    variantCount: 1,
    productCount: 1,
    missingCount: 0,
    issueCount: 0,
  });
  const prvy = await prvyPromise;
  expect(prvy.status).toBe(200);
  expect((await prvy.json()) as { status: string }).toMatchObject({ status: "accepted" });
});
