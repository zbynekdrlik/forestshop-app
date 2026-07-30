import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { auditEvents, pairings, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariant } from "./helpers/orders.js";

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
    .values({
      email: "manazer@forestshop.sk",
      passwordHash: await hashPassword(HESLO),
      displayName: "Manažér",
      role,
    })
    .returning({ id: users.id });
  if (pouzivatel === undefined) throw new Error("testovací používateľ sa nepodarilo vložiť");

  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db, userId: pouzivatel.id };
}

it("bez prihlásenia vráti 401 na oboch trasách párovania", async () => {
  const { app } = await boot("manazer");
  expect((await app.request("/api/pairing")).status).toBe(401);
  expect(
    (
      await app.request("/api/pairing/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variantCode: "A-1" }),
      })
    ).status,
  ).toBe(401);
});

it("variant bez pairing riadku sa zobrazí ako 'navrhnute' s prázdnou adresou (LEFT JOIN, nie INNER)", async () => {
  const { app, cookie, db } = await boot("citanie"); // čítanie smie vidieť stav párovania
  await insertTestVariant(db, "40237/3XL", "GRUBE");

  const res = await app.request("/api/pairing", { headers: { cookie } });
  expect(res.status).toBe(200);
  const telo = (await res.json()) as { total: number; items: unknown[] };
  expect(telo.total).toBe(1);
  expect(telo.items[0]).toMatchObject({
    variantCode: "40237/3XL",
    productSupplier: "GRUBE",
    supplierUrl: null,
    state: "navrhnute",
    confirmedByName: null,
    confirmedAt: null,
  });
});

it("potvrdený pairing nesie meno a čas potvrdenia", async () => {
  const { app, cookie, db, userId } = await boot("manazer");
  await insertTestVariant(db, "40238/M", "GRUBE");
  await db.insert(pairings).values({
    variantCode: "40238/M",
    supplierUrl: "https://www.grube.sk/p/1",
    state: "potvrdene",
    confirmedBy: userId,
    confirmedAt: new Date("2026-07-30T11:00:00Z"),
  });

  const res = await app.request("/api/pairing", { headers: { cookie } });
  const telo = (await res.json()) as {
    items: { variantCode: string; state: string; confirmedByName: string | null; confirmedAt: string | null }[];
  };
  expect(telo.items[0]).toMatchObject({
    variantCode: "40238/M",
    state: "potvrdene",
    confirmedByName: "Manažér",
  });
  expect(telo.items[0]?.confirmedAt).not.toBeNull();
});

it("filter podľa stavu vráti len navrhnuté / len potvrdené", async () => {
  const { app, cookie, db, userId } = await boot("manazer");
  await insertTestVariant(db, "40239/S", "GRUBE");
  await insertTestVariant(db, "40239/M", "GRUBE");
  await db.insert(pairings).values({
    variantCode: "40239/M",
    supplierUrl: "https://www.grube.sk/p/2",
    state: "potvrdene",
    confirmedBy: userId,
    confirmedAt: new Date("2026-07-30T11:00:00Z"),
  });

  const navrhnute = (await (
    await app.request("/api/pairing?state=navrhnute", { headers: { cookie } })
  ).json()) as { items: { variantCode: string }[] };
  expect(navrhnute.items.map((i) => i.variantCode)).toEqual(["40239/S"]);

  const potvrdene = (await (
    await app.request("/api/pairing?state=potvrdene", { headers: { cookie } })
  ).json()) as { items: { variantCode: string }[] };
  expect(potvrdene.items.map((i) => i.variantCode)).toEqual(["40239/M"]);
});

it("fulltext hľadanie podľa kódu aj názvu", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "60055/L", "GRUBE");

  const podlaKodu = (await (
    await app.request("/api/pairing?q=60055", { headers: { cookie } })
  ).json()) as { items: { variantCode: string }[] };
  expect(podlaKodu.items.map((i) => i.variantCode)).toEqual(["60055/L"]);

  const podlaNazvu = (await (
    await app.request(`/api/pairing?q=${encodeURIComponent("Test produkt 60055/L")}`, { headers: { cookie } })
  ).json()) as { items: { variantCode: string }[] };
  expect(podlaNazvu.items.map((i) => i.variantCode)).toEqual(["60055/L"]);

  const ziadnaZhoda = (await (
    await app.request("/api/pairing?q=neexistuje-vobec", { headers: { cookie } })
  ).json()) as { items: unknown[]; total: number };
  expect(ziadnaZhoda.total).toBe(0);
});

it("potvrdenie BEZ tela použije uloženú/navrhnutú adresu (jedným klikom)", async () => {
  const { app, cookie, db, userId } = await boot("manazer");
  await insertTestVariant(db, "40240/S", "GRUBE");
  await db.insert(pairings).values({ variantCode: "40240/S", supplierUrl: "https://www.grube.sk/p/3" });

  const res = await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "40240/S" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });

  const [riadok] = await db.select().from(pairings).where(eq(pairings.variantCode, "40240/S"));
  expect(riadok).toMatchObject({
    supplierUrl: "https://www.grube.sk/p/3",
    state: "potvrdene",
    confirmedBy: userId,
  });
  expect(riadok?.confirmedAt).not.toBeNull();

  const udalosti = await db.select().from(auditEvents);
  const udalost = udalosti.find((e) => e.action === "pairing.confirm");
  expect(udalost).toMatchObject({
    actorUserId: userId,
    entity: "pairing",
    entityId: "40240/S",
    data: { variantCode: "40240/S", supplierUrl: "https://www.grube.sk/p/3", manualOverride: false },
  });
});

it("potvrdenie BEZ tela a bez uloženej adresy vráti 400 (nie je čo potvrdiť)", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "40241/XL", "GRUBE");

  const res = await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "40241/XL" }),
  });
  expect(res.status).toBe(400);
  const telo = (await res.json()) as { error: string };
  expect(telo.error).toMatch(/adresa/);

  const [riadok] = await db.select().from(pairings);
  expect(riadok).toBeUndefined();
});

it("ručne zadaná adresa (zamietnutie pôvodného kandidáta) PREPÍŠE uloženú adresu a rovno potvrdí", async () => {
  const { app, cookie, db, userId } = await boot("manazer");
  await insertTestVariant(db, "40242/2XL", "GRUBE");
  // Pôvodne navrhnutá (nesprávna) adresa — manažér ju "zamietne" tým, že
  // pošle inú v tele požiadavky.
  await db.insert(pairings).values({ variantCode: "40242/2XL", supplierUrl: "https://www.grube.sk/spatna-adresa" });

  const res = await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "40242/2XL", supplierUrl: "https://www.grube.sk/p/spravna-adresa" }),
  });
  expect(res.status).toBe(200);

  const [riadok] = await db.select().from(pairings).where(eq(pairings.variantCode, "40242/2XL"));
  expect(riadok).toMatchObject({
    supplierUrl: "https://www.grube.sk/p/spravna-adresa",
    state: "potvrdene",
    confirmedBy: userId,
  });

  const udalosti = await db.select().from(auditEvents);
  const udalost = udalosti.find((e) => e.action === "pairing.confirm");
  expect(udalost?.data).toMatchObject({ manualOverride: true });
});

it("ručne zadaná adresa funguje aj keď ešte VÔBEC neexistuje pairing riadok (prvé párovanie variantu)", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "40243/3XL", "GRUBE");

  const res = await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "40243/3XL", supplierUrl: "https://www.grube.sk/p/nove" }),
  });
  expect(res.status).toBe(200);

  const [riadok] = await db.select().from(pairings).where(eq(pairings.variantCode, "40243/3XL"));
  expect(riadok).toMatchObject({ supplierUrl: "https://www.grube.sk/p/nove", state: "potvrdene" });
});

it("neplatná (nie-URL) ručne zadaná adresa vráti 400 pred akýmkoľvek zápisom", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "40244/4XL", "GRUBE");

  const res = await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "40244/4XL", supplierUrl: "nie je to url" }),
  });
  expect(res.status).toBe(400);

  const [riadok] = await db.select().from(pairings);
  expect(riadok).toBeUndefined();
});

it("neznámy variant vráti 404, nič sa nezapíše", async () => {
  const { app, cookie, db } = await boot("manazer");
  const res = await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "neexistujuci-kod", supplierUrl: "https://a.example/1" }),
  });
  expect(res.status).toBe(404);

  const [riadok] = await db.select().from(pairings);
  expect(riadok).toBeUndefined();
});

it("rola citanie nesmie potvrdiť párovanie", async () => {
  const { app, cookie, db } = await boot("citanie");
  await insertTestVariant(db, "40245/5XL", "GRUBE");
  const res = await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "40245/5XL", supplierUrl: "https://a.example/1" }),
  });
  expect(res.status).toBe(403);
});

it("rola sef tiež nesmie potvrdiť párovanie", async () => {
  const { app, cookie, db } = await boot("sef");
  await insertTestVariant(db, "40246/6XL", "GRUBE");
  const res = await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "40246/6XL", supplierUrl: "https://a.example/1" }),
  });
  expect(res.status).toBe(403);
});

it("potvrdenie s cudzím Origin je odmietnuté (403), rovnaký pôvod prejde", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "40247/7XL", "GRUBE");

  const cudzi = await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: "https://utocnik.example",
      host: "forestshop.example",
    },
    body: JSON.stringify({ variantCode: "40247/7XL", supplierUrl: "https://a.example/1" }),
  });
  expect(cudzi.status).toBe(403);

  const rovnaky = await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: "https://forestshop.example",
      host: "forestshop.example",
    },
    body: JSON.stringify({ variantCode: "40247/7XL", supplierUrl: "https://a.example/1" }),
  });
  expect(rovnaky.status).toBe(200);
});

it("dva variantné kódy toho istého produktu sa páruju NEZÁVISLE (unique na variant_code, nie na produkt)", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "40248/S", "GRUBE");
  await insertTestVariant(db, "40248/M", "GRUBE");

  await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "40248/S", supplierUrl: "https://a.example/velkost-s" }),
  });

  const zoznam = (await (await app.request("/api/pairing", { headers: { cookie } })).json()) as {
    items: { variantCode: string; state: string }[];
  };
  const s = zoznam.items.find((i) => i.variantCode === "40248/S");
  const m = zoznam.items.find((i) => i.variantCode === "40248/M");
  expect(s?.state).toBe("potvrdene");
  expect(m?.state).toBe("navrhnute"); // druhá veľkosť zostáva nedotknutá
});

// Review nález na PR #54 (issue 45): `onConflictDoUpdate` v `confirmPairing()`
// donedávna prepisoval `confirmedBy`/`confirmedAt` BEZOHĽADNE na to, či ide o
// SKUTOČNÉ nové rozhodnutie, alebo len o opätovné potvrdenie TEJ ISTEJ (už
// potvrdenej) adresy. Tieto dva testy potrebujú DVOCH rôznych prihlásených
// manažérov naraz — `boot()` (jeden `withCleanDb()` per volanie) by druhé
// volanie zneplatnilo prvé (`.claude/rules/testing.md`), preto tu ide priama
// `withCleanDb()` + dve prihlásenia pod TÝM ISTÝM `app`/`db`.
it("opätovné potvrdenie s NEZMENENOU adresou zachová PÔVODNÉHO potvrdzujúceho a jeho čas (žiadne nové rozhodnutie, žiadny nový audit event)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const [prvy] = await ctx.db
    .insert(users)
    .values({
      email: "prvy-manazer@forestshop.sk",
      passwordHash: await hashPassword(HESLO),
      displayName: "Prvý Manažér",
      role: "manazer",
    })
    .returning({ id: users.id });
  const [druhy] = await ctx.db
    .insert(users)
    .values({
      email: "druhy-manazer@forestshop.sk",
      passwordHash: await hashPassword(HESLO),
      displayName: "Druhý Manažér",
      role: "manazer",
    })
    .returning({ id: users.id });
  if (prvy === undefined || druhy === undefined) throw new Error("testovacích používateľov sa nepodarilo vložiť");

  const app = createApp(ctx.db, { cookieSecure: false });
  await insertTestVariant(ctx.db, "40249/S", "GRUBE");

  async function prihlas(email: string): Promise<string> {
    const res = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: HESLO }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }

  const prvyCookie = await prihlas("prvy-manazer@forestshop.sk");
  const prvePotvrdenie = await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: { cookie: prvyCookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "40249/S", supplierUrl: "https://www.grube.sk/p/nezmenena" }),
  });
  expect(prvePotvrdenie.status).toBe(200);

  const [poPrvom] = await ctx.db.select().from(pairings).where(eq(pairings.variantCode, "40249/S"));
  expect(poPrvom?.confirmedBy).toBe(prvy.id);
  const povodnyCas = poPrvom?.confirmedAt;
  expect(povodnyCas).not.toBeNull();

  // Druhý manažér klikne "✓ Potvrdiť jedným klikom" na TEJ ISTEJ (už
  // potvrdenej) adrese — žiadne nové rozhodnutie nebolo urobené.
  const druheCookie = await prihlas("druhy-manazer@forestshop.sk");
  const druhePotvrdenie = await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: { cookie: druheCookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "40249/S" }),
  });
  expect(druhePotvrdenie.status).toBe(200);
  expect(await druhePotvrdenie.json()).toEqual({ ok: true });

  const [poDruhom] = await ctx.db.select().from(pairings).where(eq(pairings.variantCode, "40249/S"));
  expect(poDruhom).toMatchObject({
    supplierUrl: "https://www.grube.sk/p/nezmenena",
    state: "potvrdene",
    confirmedBy: prvy.id, // PÔVODNÝ potvrdzujúci, nie druhý manažér
  });
  expect(poDruhom?.confirmedAt).toEqual(povodnyCas); // čas potvrdenia sa NEZMENIL

  const auditPairingConfirm = (await ctx.db.select().from(auditEvents)).filter(
    (e) => e.action === "pairing.confirm",
  );
  expect(auditPairingConfirm).toHaveLength(1); // no-op re-potvrdenie NEZAPÍŠE druhý audit event
});

it("opätovné potvrdenie s INOU adresou JE nové rozhodnutie — prepíše potvrdzujúceho, čas aj zapíše nový audit event", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const [prvy] = await ctx.db
    .insert(users)
    .values({
      email: "prvy-manazer@forestshop.sk",
      passwordHash: await hashPassword(HESLO),
      displayName: "Prvý Manažér",
      role: "manazer",
    })
    .returning({ id: users.id });
  const [druhy] = await ctx.db
    .insert(users)
    .values({
      email: "druhy-manazer@forestshop.sk",
      passwordHash: await hashPassword(HESLO),
      displayName: "Druhý Manažér",
      role: "manazer",
    })
    .returning({ id: users.id });
  if (prvy === undefined || druhy === undefined) throw new Error("testovacích používateľov sa nepodarilo vložiť");

  const app = createApp(ctx.db, { cookieSecure: false });
  await insertTestVariant(ctx.db, "40250/M", "GRUBE");

  async function prihlas(email: string): Promise<string> {
    const res = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: HESLO }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }

  const prvyCookie = await prihlas("prvy-manazer@forestshop.sk");
  await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: { cookie: prvyCookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "40250/M", supplierUrl: "https://www.grube.sk/p/povodna" }),
  });

  const [poPrvom] = await ctx.db.select().from(pairings).where(eq(pairings.variantCode, "40250/M"));
  const povodnyCas = poPrvom?.confirmedAt;

  const druheCookie = await prihlas("druhy-manazer@forestshop.sk");
  const druhePotvrdenie = await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: { cookie: druheCookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "40250/M", supplierUrl: "https://www.grube.sk/p/oprava" }),
  });
  expect(druhePotvrdenie.status).toBe(200);

  const [poDruhom] = await ctx.db.select().from(pairings).where(eq(pairings.variantCode, "40250/M"));
  expect(poDruhom).toMatchObject({
    supplierUrl: "https://www.grube.sk/p/oprava",
    state: "potvrdene",
    confirmedBy: druhy.id, // TOTO je skutočné nové rozhodnutie — attribution sa právom presunie
  });
  expect(poDruhom?.confirmedAt).not.toEqual(povodnyCas);

  const auditPairingConfirm = (await ctx.db.select().from(auditEvents)).filter(
    (e) => e.action === "pairing.confirm",
  );
  expect(auditPairingConfirm).toHaveLength(2); // skutočná zmena adresy JE nové rozhodnutie → nový audit event
});
