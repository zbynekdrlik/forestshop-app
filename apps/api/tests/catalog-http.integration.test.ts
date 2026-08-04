import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { sessions, users, variants } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { SESSION_COOKIE } from "../src/http/middleware.js";
import { ingestCatalog, type CatalogIngestResult } from "../src/modules/catalog/ingest.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { newSessionToken } from "../src/modules/auth/sessions.js";
import { DEFAULT_SNAPSHOT_LIMITS } from "../src/modules/catalog/validation.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
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
  // Bez tohto sa počítadlo POST /api/login (login-rate-limit.ts) hromadí
  // NAPRIEČ testami v tomto súbore (rovnaký e-mail, žiadna x-forwarded-for
  // hlavička → rovnaký (ip, e-mail) kľúč) — pri 10. prihlásení v poradí by
  // ďalší test dostal 429 namiesto skutočnej odpovede (review task-6-fix-1;
  // rovnaký reset ako `http.integration.test.ts`).
  resetLoginRateLimit();
});

async function boot(options: { readonly role: UserRole; readonly seed: boolean }) {
  const ctx = await withCleanDb();
  close = ctx.close;
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-http-"));
  const dir = rawDir;

  const [pouzivatel] = await ctx.db
    .insert(users)
    .values({
      email: "manazer@forestshop.sk",
      passwordHash: await hashPassword(HESLO),
      displayName: "Manažér",
      role: options.role,
    })
    .returning({ id: users.id });
  if (pouzivatel === undefined) throw new Error("testovací používateľ sa nepodarilo vložiť");

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
  return { app, cookie, db: ctx.db, userId: pouzivatel.id };
}

it("neplatná session (falošný alebo expirovaný token) vráti 401 na všetkých piatich trasách katalógu", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const [pouzivatel] = await ctx.db
    .insert(users)
    .values({
      email: "manazer@forestshop.sk",
      passwordHash: await hashPassword(HESLO),
      displayName: "Manažér",
      role: "manazer",
    })
    .returning({ id: users.id });
  if (pouzivatel === undefined) throw new Error("testovací používateľ sa nepodarilo vložiť");

  // Falošný token — nikdy ho nevydal server, takže jeho hash v `sessions` nie je.
  const falosnyToken = "falosny-token-nikdy-nevydany-serverom";
  // Expirovaný token — REÁLNY riadok v `sessions`, len s `expiresAt` v minulosti.
  const { token: expirovanyToken, tokenHash } = newSessionToken();
  await ctx.db.insert(sessions).values({
    tokenHash,
    userId: pouzivatel.id,
    expiresAt: new Date(NOW.getTime() - 1000),
  });

  const app = createApp(ctx.db, { cookieSecure: false });
  const trasy: { readonly path: string; readonly method: "GET" | "POST" }[] = [
    { path: "/api/catalog/stats", method: "GET" },
    { path: "/api/catalog/snapshots", method: "GET" },
    { path: "/api/catalog/variants", method: "GET" },
    { path: "/api/catalog/variants/40237%2F3XL", method: "GET" },
    { path: "/api/catalog/ingest", method: "POST" },
  ];

  for (const token of [falosnyToken, expirovanyToken]) {
    for (const trasa of trasy) {
      const res = await app.request(trasa.path, {
        method: trasa.method,
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      });
      expect(res.status).toBe(401);
    }
  }
});

it("vráti prehľad katalógu", async () => {
  const { app, cookie } = await boot({ role: "manazer", seed: true });
  // `productCount` je teraz pripnutý na hodnotu odvodenú PRIAMO z fixtúry (8
  // distinct `guid` naprieč jej 35 riadkami — final-wave-b, položka 6):
  // predtým sa derivoval dopytom nad `products`, teda z tej istej tabuľky,
  // ktorú endpoint sám číta — čo test robilo tautologickým (zlá implementácia
  // by prešla rovnako ako dobrá). Identita produktu (`guid`) je teraz
  // usadená, takže sa dá pinnúť na skutočné číslo.
  const res = await app.request("/api/catalog/stats", { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    variantCount: 35,
    productCount: 8,
    // issue 219: 40237/L má oba texty dostupnosti prázdne — prázdny text
    // znamená predvolenú dostupnosť Shoptetu, nie vypredané, takže je predajný.
    sellable: 7,
    outOfStock: 1,
    discontinued: 27,
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

it("vyhľadávací dotaz escapuje % a _ ako doslovné znaky, nie ako žolíky", async () => {
  const { app, cookie } = await boot({ role: "manazer", seed: true });

  const cely = await app.request("/api/catalog/variants", { headers: { cookie } });
  const celyVysledok = (await cely.json()) as { total: number };

  // Ani `_`, ani `%` sa v kóde/názve fixtúry nevyskytujú ako doslovný znak — bez
  // escapovania by `_` (žolík "ľubovoľný jeden znak") aj `%` (žolík "ľubovoľná
  // postupnosť") v obale `%…%` zodpovedali prakticky každému neprázdnemu
  // reťazcu, takže by dopyt vrátil CELÝ katalóg namiesto pár riadkov.
  const podciarkovnik = await app.request("/api/catalog/variants?q=_", { headers: { cookie } });
  const podciarkovnikVysledok = (await podciarkovnik.json()) as { total: number };
  expect(podciarkovnikVysledok.total).toBeLessThan(celyVysledok.total);

  const percento = await app.request("/api/catalog/variants?q=%25", { headers: { cookie } });
  const percentoVysledok = (await percento.json()) as { total: number };
  expect(percentoVysledok.total).toBeLessThan(celyVysledok.total);
});

it("filtruje podľa stavu a stránkuje bez duplicít a preskočení", async () => {
  const { app, cookie } = await boot({ role: "manazer", seed: true });

  const skladom = await app.request("/api/catalog/variants?state=sellable", { headers: { cookie } });
  expect((await skladom.json()) as { total: number }).toMatchObject({ total: 7 });

  // Referenčný, neostránkovaný zoznam (35 variantov sa zmestí do jednej strany
  // s pageSize=200) — voči nemu sa overuje, že strana 2 začína PRESNE tam, kde
  // strana 1 skončila pod deklarovaným triedením (review task-6-fix-1: pôvodný
  // test kontroloval len `total`/dĺžku poľa, nie SKUTOČNÝ obsah stránok).
  const cele = await app.request("/api/catalog/variants?pageSize=200", { headers: { cookie } });
  const vsetko = (await cele.json()) as { items: { code: string }[] };

  const prvaRes = await app.request("/api/catalog/variants?pageSize=10&page=1", { headers: { cookie } });
  const druhaRes = await app.request("/api/catalog/variants?pageSize=10&page=2", { headers: { cookie } });
  const prva = (await prvaRes.json()) as { items: { code: string }[] };
  const druha = (await druhaRes.json()) as { items: { code: string }[] };

  expect(prva.items.map((i) => i.code)).toEqual(vsetko.items.slice(0, 10).map((i) => i.code));
  expect(druha.items.map((i) => i.code)).toEqual(vsetko.items.slice(10, 20).map((i) => i.code));

  const prveKody = new Set(prva.items.map((i) => i.code));
  const druheKody = druha.items.map((i) => i.code);
  expect(druheKody.some((code) => prveKody.has(code))).toBe(false);
});

it("veľmi veľká hodnota page vráti 400 namiesto pretečenia do DB chyby", async () => {
  const { app, cookie } = await boot({ role: "manazer", seed: true });
  // Pred opravou: offset = (1e21 - 1) * 50 ≈ 5e22, čo Postgres odmietne s
  // "invalid input syntax for type bigint" a to uniká ako 500.
  const res = await app.request("/api/catalog/variants?page=1e21", { headers: { cookie } });
  expect(res.status).toBe(400);
});

it("prázdna hodnota page= sa správa ako neprítomná (predvolená prvá strana)", async () => {
  const { app, cookie } = await boot({ role: "manazer", seed: true });
  const prazdna = await app.request("/api/catalog/variants?page=", { headers: { cookie } });
  const explicitna = await app.request("/api/catalog/variants?page=1", { headers: { cookie } });
  expect(prazdna.status).toBe(200);
  expect(await prazdna.json()).toEqual(await explicitna.json());
});

it("odmietne neplatný parameter stavu", async () => {
  const { app, cookie } = await boot({ role: "manazer", seed: true });
  expect((await app.request("/api/catalog/variants?state=hocico", { headers: { cookie } })).status).toBe(400);
});

// Important (review final-wave-a, položka 6): variant, ktorý zmizol z
// exportu, sa v čítacej ceste doteraz nedal nájsť — pole sa síce vyberalo a
// typovalo, ale nikdy sa nezobrazovalo ani nedalo filtrovať. `missing` je
// PSEUDO-stav (nie hodnota stĺpca `state`) — filtruje podľa `missingSince IS
// NOT NULL`, nezávisle od toho, aký `state` mal variant naposledy.
it("filter 'missing' vráti len variant so zaznamenaným missingSince, nezávisle od jeho state", async () => {
  const { app, cookie, db } = await boot({ role: "manazer", seed: true });

  await db.update(variants).set({ missingSince: NOW }).where(eq(variants.code, "40287"));

  const res = await app.request("/api/catalog/variants?state=missing", { headers: { cookie } });
  expect(res.status).toBe(200);
  const telo = (await res.json()) as {
    total: number;
    items: { code: string; missingSince: string | null }[];
  };
  expect(telo.total).toBe(1);
  expect(telo.items[0]).toMatchObject({ code: "40287", missingSince: NOW.toISOString() });

  // Ostatné filtre zostávajú nedotknuté — "missing" nie je skutočná hodnota
  // stĺpca `state`, takže `state=sellable` naďalej vidí ten istý počet ako
  // predtým (variant "40287" je "sellable", stále sa počíta tam AJ v "missing").
  const skladom = await app.request("/api/catalog/variants?state=sellable", { headers: { cookie } });
  expect((await skladom.json()) as { total: number }).toMatchObject({ total: 7 });
});

it("vráti detail variantu a 404 pre neznámy kód", async () => {
  const { app, cookie } = await boot({ role: "manazer", seed: true });

  // `productKey` je teraz pripnutý na `guid` skutočne prítomný vo fixtúre pre
  // skupinu "40237" (final-wave-b, položka 6) — predtým sa derivoval dopytom
  // nad `variants`, teda z tej istej tabuľky, ktorú endpoint sám číta, čo
  // test robilo tautologickým. Identita produktu (`guid`) je teraz usadená,
  // takže sa dá pinnúť na skutočnú hodnotu z fixtúry.
  const detail = await app.request("/api/catalog/variants/40237%2F3XL", { headers: { cookie } });
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({
    code: "40237/3XL",
    productKey: "0a486205-d9e7-11e0-92ec-e1ef0b66e031",
    sizeLabel: "3XL",
    price: "62.76",
    currency: "EUR",
    state: "discontinued",
    availabilityInStockText: "Predaj výrobku skončil",
  });

  expect((await app.request("/api/catalog/variants/NEEXISTUJE", { headers: { cookie } })).status).toBe(404);
});

it("nákupnú cenu vidí manažér, čitateľská rola ju nevidí", async () => {
  // JEDEN spoločný `withCleanDb`/app — dva samostatné `boot()` volania by sa
  // navzájom prepísali (`withCleanDb` pri druhom volaní TRUNCATE-uje tie isté
  // zdieľané tabuľky vrátane `sessions`, takže by zneplatnilo session z
  // prvého volania skôr, než sa stihne použiť).
  const ctx = await withCleanDb();
  close = ctx.close;
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-http-"));
  const dir = rawDir;

  await ctx.db.insert(users).values([
    {
      email: "manazer@forestshop.sk",
      passwordHash: await hashPassword(HESLO),
      displayName: "Manažér",
      role: "manazer",
    },
    {
      email: "citac@forestshop.sk",
      passwordHash: await hashPassword(HESLO),
      displayName: "Čitateľ",
      role: "citanie",
    },
  ]);
  await ingestCatalog(ctx.db, {
    fetchExport: () => Promise.resolve({ body: FIXTURE, sourceLabel: "fixtúra" }),
    now: NOW,
    rawDir: dir,
    limits: TEST_LIMITS,
  });

  const app = createApp(ctx.db, { cookieSecure: false });
  const prihlas = async (email: string): Promise<string> => {
    const res = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: HESLO }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const manazerCookie = await prihlas("manazer@forestshop.sk");
  const citanieCookie = await prihlas("citac@forestshop.sk");

  const preManazera = await app.request("/api/catalog/variants/40237%2F3XL", {
    headers: { cookie: manazerCookie },
  });
  const telo1 = (await preManazera.json()) as { purchasePrice: string | null };
  expect(typeof telo1.purchasePrice).toBe("string");

  const preCitanie = await app.request("/api/catalog/variants/40237%2F3XL", {
    headers: { cookie: citanieCookie },
  });
  const telo2 = (await preCitanie.json()) as { purchasePrice: string | null };
  expect(telo2.purchasePrice).toBeNull();
});

it("vypíše snapshoty od najnovšieho a limit skutočne obmedzuje počet", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({
    email: "manazer@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Manažér",
    role: "manazer",
  });

  await insertTestSnapshot(ctx.db, {
    fetchedAt: new Date("2026-07-01T08:00:00Z"),
    rowCount: 30,
  });
  await insertTestSnapshot(ctx.db, {
    fetchedAt: new Date("2026-07-15T08:00:00Z"),
    rowCount: 32,
  });

  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  // limit=1 pri DVOCH existujúcich snapshotoch dokazuje, že limit SKUTOČNE
  // obmedzuje (pôvodný test mal vo fixtúre len jeden snapshot, takže limit sa
  // dal zmazať bez toho, aby test spadol — review task-6-fix-1).
  const obmedzeny = await app.request("/api/catalog/snapshots?limit=1", { headers: { cookie } });
  const obmedzenyData = (await obmedzeny.json()) as { items: { rowCount: number }[] };
  expect(obmedzenyData.items).toHaveLength(1);
  expect(obmedzenyData.items[0]).toMatchObject({ rowCount: 32 });

  const oba = await app.request("/api/catalog/snapshots?limit=5", { headers: { cookie } });
  const obaData = (await oba.json()) as { items: { rowCount: number }[] };
  expect(obaData.items.map((i) => i.rowCount)).toEqual([32, 30]);
});

it("snapshoty so zhodným fetchedAt majú stabilné (deterministické) sekundárne triedenie", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({
    email: "manazer@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Manažér",
    role: "manazer",
  });

  const zhodnyCas = new Date("2026-07-20T09:00:00Z");
  const idA = await insertTestSnapshot(ctx.db, { fetchedAt: zhodnyCas, rowCount: 10 });
  const idB = await insertTestSnapshot(ctx.db, { fetchedAt: zhodnyCas, rowCount: 11 });
  const ocakavanePoradie = [idA, idB].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const prvy = await app.request("/api/catalog/snapshots", { headers: { cookie } });
  const prvyData = (await prvy.json()) as { items: { id: string }[] };
  const druhy = await app.request("/api/catalog/snapshots", { headers: { cookie } });
  const druhyData = (await druhy.json()) as { items: { id: string }[] };

  expect(prvyData.items.map((i) => i.id)).toEqual(ocakavanePoradie);
  expect(druhyData.items.map((i) => i.id)).toEqual(prvyData.items.map((i) => i.id));
});

// Smaller correctness item (review final-wave-a, položka 7): `/api/catalog/stats`
// vyberá "posledný snapshot" pre hlavičkovú vetu stránky triedením LEN podľa
// `fetchedAt` — bez sekundárneho tie-breaku `desc(id)`, ktorý `listSnapshots`
// (aj `ingest.ts`) má. Dva snapshoty so ZHODNÝM `fetchedAt` (rovnaká
// milisekunda, alebo vstreknuté `now` v teste) by inak dostali poradie, ktoré
// Postgres negarantuje.
it("prehľad (stats) vyberie 'posledný snapshot' rovnakým stabilným tie-breakom ako zoznam snapshotov", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({
    email: "manazer@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Manažér",
    role: "manazer",
  });

  const zhodnyCas = new Date("2026-07-20T09:00:00Z");
  const idA = await insertTestSnapshot(ctx.db, { fetchedAt: zhodnyCas, rowCount: 10 });
  const idB = await insertTestSnapshot(ctx.db, { fetchedAt: zhodnyCas, rowCount: 11 });
  // Rovnaký vzorec ako `listSnapshots`/`ingest.ts`: `desc(fetchedAt), desc(id)`.
  const ocakavanyVitaz = idA > idB ? idA : idB;

  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const res = await app.request("/api/catalog/stats", { headers: { cookie } });
  const telo = (await res.json()) as { lastSnapshot: { id: string } | null };
  expect(telo.lastSnapshot?.id).toBe(ocakavanyVitaz);
});
