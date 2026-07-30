import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { auditEvents, pairings, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariant } from "./helpers/orders.js";

const HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

// Review nález na PR 54 (issue 45): `onConflictDoUpdate` v `confirmPairing()`
// (`modules/pairing/state.ts`) donedávna prepisoval `confirmedBy`/
// `confirmedAt` BEZOHĽADNE na to, či ide o SKUTOČNÉ nové rozhodnutie, alebo
// len o opätovné potvrdenie TEJ ISTEJ (už potvrdenej) adresy. Oba testy
// tu potrebujú DVOCH rôznych prihlásených manažérov naraz — `boot()`-štýl
// helper (jeden `withCleanDb()` per volanie) by druhé volanie zneplatnilo
// prvé (`.claude/rules/testing.md`), preto tu ide priama `withCleanDb()` +
// dve prihlásenia pod TÝM ISTÝM `app`/`db`.
async function pripravDvochManazerov(): Promise<{
  app: ReturnType<typeof createApp>;
  db: Awaited<ReturnType<typeof withCleanDb>>["db"];
  prvyId: string;
  druhyId: string;
  prihlas: (email: string) => Promise<string>;
}> {
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

  async function prihlas(email: string): Promise<string> {
    const res = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: HESLO }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }

  return { app, db: ctx.db, prvyId: prvy.id, druhyId: druhy.id, prihlas };
}

it("opätovné potvrdenie s NEZMENENOU adresou zachová PÔVODNÉHO potvrdzujúceho a jeho čas (žiadne nové rozhodnutie, žiadny nový audit event)", async () => {
  const { app, db, prvyId, prihlas } = await pripravDvochManazerov();
  await insertTestVariant(db, "40249/S", "GRUBE");

  const prvyCookie = await prihlas("prvy-manazer@forestshop.sk");
  const prvePotvrdenie = await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: { cookie: prvyCookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "40249/S", supplierUrl: "https://www.grube.sk/p/nezmenena" }),
  });
  expect(prvePotvrdenie.status).toBe(200);

  const [poPrvom] = await db.select().from(pairings).where(eq(pairings.variantCode, "40249/S"));
  expect(poPrvom?.confirmedBy).toBe(prvyId);
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

  const [poDruhom] = await db.select().from(pairings).where(eq(pairings.variantCode, "40249/S"));
  expect(poDruhom).toMatchObject({
    supplierUrl: "https://www.grube.sk/p/nezmenena",
    state: "potvrdene",
    confirmedBy: prvyId, // PÔVODNÝ potvrdzujúci, nie druhý manažér
  });
  expect(poDruhom?.confirmedAt).toEqual(povodnyCas); // čas potvrdenia sa NEZMENIL

  const auditPairingConfirm = (await db.select().from(auditEvents)).filter((e) => e.action === "pairing.confirm");
  expect(auditPairingConfirm).toHaveLength(1); // no-op re-potvrdenie NEZAPÍŠE druhý audit event
});

it("opätovné potvrdenie s INOU adresou JE nové rozhodnutie — prepíše potvrdzujúceho, čas aj zapíše nový audit event", async () => {
  const { app, db, druhyId, prihlas } = await pripravDvochManazerov();
  await insertTestVariant(db, "40250/M", "GRUBE");

  const prvyCookie = await prihlas("prvy-manazer@forestshop.sk");
  await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: { cookie: prvyCookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "40250/M", supplierUrl: "https://www.grube.sk/p/povodna" }),
  });

  const [poPrvom] = await db.select().from(pairings).where(eq(pairings.variantCode, "40250/M"));
  const povodnyCas = poPrvom?.confirmedAt;

  const druheCookie = await prihlas("druhy-manazer@forestshop.sk");
  const druhePotvrdenie = await app.request("/api/pairing/confirm", {
    method: "POST",
    headers: { cookie: druheCookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "40250/M", supplierUrl: "https://www.grube.sk/p/oprava" }),
  });
  expect(druhePotvrdenie.status).toBe(200);

  const [poDruhom] = await db.select().from(pairings).where(eq(pairings.variantCode, "40250/M"));
  expect(poDruhom).toMatchObject({
    supplierUrl: "https://www.grube.sk/p/oprava",
    state: "potvrdene",
    confirmedBy: druhyId, // TOTO je skutočné nové rozhodnutie — attribution sa právom presunie
  });
  expect(poDruhom?.confirmedAt).not.toEqual(povodnyCas);

  const auditPairingConfirm = (await db.select().from(auditEvents)).filter((e) => e.action === "pairing.confirm");
  expect(auditPairingConfirm).toHaveLength(2); // skutočná zmena adresy JE nové rozhodnutie → nový audit event
});
