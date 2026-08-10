import { afterEach, expect, it } from "vitest";
import { productSupplierLinkOverrides, products, users, variants } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";
import type { Database } from "../src/db/client.js";

// issue 311: "Vypredané → Skladom: návrhy odkazov" — LEN čítanie
// (`GET /api/restock-links`). Zápis potvrdeného odkazu ide cez UŽ
// existujúcu `POST /api/product-links/:productKey` trasu, otestovanú v
// `product-links-http.integration.test.ts` — tu sa neduplikuje.

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

interface Telo {
  readonly total: number;
  readonly items: {
    readonly productKey: string;
    readonly productName: string;
    readonly supplier: string | null;
    readonly candidates: { readonly productKey: string; readonly productName: string; readonly url: string }[];
  }[];
}

async function seedVariant(
  db: Database,
  snapshotId: string,
  productKey: string,
  code: string,
  over: {
    readonly name: string;
    readonly supplier?: string | null;
    readonly internalNote?: string | null;
    readonly state?: "sellable" | "out_of_stock" | "discontinued";
    readonly productVisibility?: string;
    readonly missingSince?: Date | null;
  },
): Promise<void> {
  const now = new Date("2026-08-07T00:00:00Z");
  await db.insert(products).values({
    key: productKey,
    name: over.name,
    supplier: over.supplier ?? null,
    internalNote: over.internalNote ?? null,
    firstSeenAt: now,
    lastSeenAt: now,
    lastSeenSnapshotId: snapshotId,
  });
  await db.insert(variants).values({
    code,
    productKey,
    guid: productKey,
    name: over.name,
    stock: 0,
    availabilityInStockText: "Skladom",
    availabilityOutOfStockText: "Vypredané",
    availabilityText: over.state === "out_of_stock" ? "Vypredané" : "Skladom",
    productVisibility: over.productVisibility ?? "visible",
    state: over.state ?? "sellable",
    missingSince: over.missingSince ?? null,
    firstSeenAt: now,
    lastSeenAt: now,
    lastSeenSnapshotId: snapshotId,
  });
}

it("bez prihlásenia vráti 401", async () => {
  const { app } = await boot("manazer");
  expect((await app.request("/api/restock-links")).status).toBe(401);
});

it("vypredaný viditeľný produkt bez linky sa zobrazí, s odvodeným kandidátom podľa zhody mena + dodávateľa", async () => {
  const { app, cookie, db } = await boot("citanie"); // čítanie smie vidieť zoznam
  const snapshotId = await insertTestSnapshot(db);

  // Chýbajúca linka — vypredaný, viditeľný, stále v exporte.
  await seedVariant(db, snapshotId, "RL-MISSING", "RL-MISSING/1", {
    name: "Bunda Alfa Zimná",
    supplier: "DODAVATEL-RL",
    state: "out_of_stock",
  });
  // Kandidát — ROVNAKÝ dodávateľ, prekrývajúce sa slová názvu ("Bunda"/"Alfa").
  await seedVariant(db, snapshotId, "RL-CANDIDATE", "RL-CANDIDATE/1", {
    name: "Bunda Alfa Letná",
    supplier: "DODAVATEL-RL",
    internalNote: "https://dodavatel.example.com/bunda-alfa-letna",
  });
  // Cudzí dodávateľ, žiadna zhoda mena — nesmie sa nikdy navrhnúť.
  await seedVariant(db, snapshotId, "RL-UNRELATED", "RL-UNRELATED/1", {
    name: "Šál Zeta",
    supplier: "INY-DODAVATEL",
    internalNote: "https://iny.example.com/sal-zeta",
  });

  const res = await app.request("/api/restock-links?q=RL-MISSING", { headers: { cookie } });
  expect(res.status).toBe(200);
  const telo = (await res.json()) as Telo;
  const item = telo.items.find((i) => i.productKey === "RL-MISSING");
  expect(item?.productName).toBe("Bunda Alfa Zimná");
  expect(item?.candidates).toHaveLength(1);
  expect(item?.candidates[0]).toMatchObject({
    productKey: "RL-CANDIDATE",
    url: "https://dodavatel.example.com/bunda-alfa-letna",
  });
});

it("produkt s efektívnou linkou z internalNote sa v zozname nezobrazí", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedVariant(db, snapshotId, "RL-HASLINK", "RL-HASLINK/1", {
    name: "Vypredaná bunda s linkou",
    internalNote: "https://dodavatel.example.com/uz-ma-linku",
    state: "out_of_stock",
  });

  const telo = (await (await app.request("/api/restock-links?q=RL-HASLINK", { headers: { cookie } })).json()) as Telo;
  expect(telo.items.some((i) => i.productKey === "RL-HASLINK")).toBe(false);
});

// Code review (issue 311): pôvodný test vyššie mal v názve "aj cez
// override", ale žiadny override riadok nikdy nevkladal — nový kód
// (`resolveEffectiveSupplierLink`'s override vetva, `queries.ts`) tak
// zostal touto sadou testov neotestovaný. Produkt tu NEMÁ `internalNote`
// vôbec (`null`), efektívna linka pochádza VÝHRADNE z override riadku.
it("produkt s efektívnou linkou LEN z override (bez internalNote) sa v zozname nezobrazí", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedVariant(db, snapshotId, "RL-OVERRIDE", "RL-OVERRIDE/1", {
    name: "Vypredaná bunda s override linkou",
    state: "out_of_stock",
  });
  await db
    .insert(productSupplierLinkOverrides)
    .values({ productKey: "RL-OVERRIDE", url: "https://dodavatel.example.com/z-override", updatedAt: new Date() });

  const telo = (await (await app.request("/api/restock-links?q=RL-OVERRIDE", { headers: { cookie } })).json()) as Telo;
  expect(telo.items.some((i) => i.productKey === "RL-OVERRIDE")).toBe(false);
});

it("predajný (nie vypredaný) produkt bez linky sa v zozname nezobrazí", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedVariant(db, snapshotId, "RL-SELLABLE", "RL-SELLABLE/1", { name: "Predajný produkt bez linky", state: "sellable" });

  const telo = (await (await app.request("/api/restock-links?q=RL-SELLABLE", { headers: { cookie } })).json()) as Telo;
  expect(telo.items).toHaveLength(0);
});

it("vypredaný produkt skrytý pred zákazníkom (nie 'visible') sa v zozname nezobrazí", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedVariant(db, snapshotId, "RL-HIDDEN", "RL-HIDDEN/1", {
    name: "Vypredaný skrytý produkt",
    state: "out_of_stock",
    productVisibility: "hidden",
  });

  const telo = (await (await app.request("/api/restock-links?q=RL-HIDDEN", { headers: { cookie } })).json()) as Telo;
  expect(telo.items).toHaveLength(0);
});

it("vypredaný produkt, ktorý už zmizol z exportu (missingSince), sa v zozname nezobrazí", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedVariant(db, snapshotId, "RL-MISSINGSINCE", "RL-MISSINGSINCE/1", {
    name: "Vypredaný zmiznutý produkt",
    state: "out_of_stock",
    missingSince: new Date("2026-08-01T00:00:00Z"),
  });

  const telo = (await (await app.request("/api/restock-links?q=RL-MISSINGSINCE", { headers: { cookie } })).json()) as Telo;
  expect(telo.items).toHaveLength(0);
});

// Code review (issue 311): pridané, lebo `SAME_SUPPLIER_BONUS` — jediná
// netriviálna obchodná logika tejto zmeny — dovtedy nemala ŽIADEN priamy
// test. Kandidát s ROVNAKÝM dodávateľom, ale NIŽŠÍM prekryvom slov mena
// (1 slovo), musí vyhrať nad kandidátom s CUDZÍM dodávateľom a VYŠŠÍM
// prekryvom (2 slová) — bonus (100) musí prebiť akýkoľvek rozdiel v
// samotnom textovom skóre.
it("kandidát s ROVNAKÝM dodávateľom vyhrá nad kandidátom s vyšším prekryvom mena z CUDZIEHO dodávateľa", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedVariant(db, snapshotId, "RL-SKORE-CHYBA", "RL-SKORE-CHYBA/1", {
    name: "Bunda Alfa Zimná",
    supplier: "DODAVATEL-RL-SKORE",
    state: "out_of_stock",
  });
  // Rovnaký dodávateľ, zdieľa LEN jedno slovo ("bunda") — skóre 1 + bonus 100.
  await seedVariant(db, snapshotId, "RL-SKORE-VYHRA", "RL-SKORE-VYHRA/1", {
    name: "Bunda Iná",
    supplier: "DODAVATEL-RL-SKORE",
    internalNote: "https://dodavatel.example.com/rovnaky-dodavatel",
  });
  // Cudzí dodávateľ, zdieľa DVE slová ("bunda", "alfa") — skóre 2, bez bonusu.
  await seedVariant(db, snapshotId, "RL-SKORE-PREHRA", "RL-SKORE-PREHRA/1", {
    name: "Bunda Alfa Extra",
    supplier: "INY-DODAVATEL-RL-SKORE",
    internalNote: "https://iny.example.com/cudzi-dodavatel",
  });

  const telo = (await (await app.request("/api/restock-links?q=RL-SKORE-CHYBA", { headers: { cookie } })).json()) as Telo;
  const item = telo.items.find((i) => i.productKey === "RL-SKORE-CHYBA");
  expect(item?.candidates.map((c) => c.productKey)).toEqual(["RL-SKORE-VYHRA", "RL-SKORE-PREHRA"]);
});

// Code review (issue 311): `CANDIDATE_LIMIT = 3` (queries.ts) tiež nemal
// žiadny priamy test — 4 rovnako skórované kandidáti (rovnaký dodávateľ,
// rovnaký jedno-slovný prekryv) musia vrátiť LEN 3, zoradené abecedne pri
// zhodnom skóre (tie-break v `suggestCandidates`).
it("vráti najviac 3 kandidátov aj keď rovnako skórovaných vyhovuje viac", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedVariant(db, snapshotId, "RL-STROP-CHYBA", "RL-STROP-CHYBA/1", {
    name: "Bunda Alfa Zimná",
    supplier: "DODAVATEL-RL-STROP",
    state: "out_of_stock",
  });
  for (const suffix of ["D4", "C3", "B2", "A1"]) {
    await seedVariant(db, snapshotId, `RL-STROP-${suffix}`, `RL-STROP-${suffix}/1`, {
      name: `Bunda ${suffix}`,
      supplier: "DODAVATEL-RL-STROP",
      internalNote: `https://dodavatel.example.com/strop-${suffix.toLowerCase()}`,
    });
  }

  const telo = (await (await app.request("/api/restock-links?q=RL-STROP-CHYBA", { headers: { cookie } })).json()) as Telo;
  const item = telo.items.find((i) => i.productKey === "RL-STROP-CHYBA");
  expect(item?.candidates).toHaveLength(3);
  // Rovnaké skóre pre všetky 4 → tie-break podľa mena, abecedne.
  expect(item?.candidates.map((c) => c.productKey)).toEqual(["RL-STROP-A1", "RL-STROP-B2", "RL-STROP-C3"]);
});

// issue 331: odznak v ľavom menu (`App.tsx`) čítava TENTO endpoint s
// `pageSize=1` (lacný dopyt na samotný počet, `restockLinksApi.ts`'s
// `fetchRestockLinksMissingCount`) — `total` sa MUSÍ počítať nad CELOU
// odfiltrovanou množinou nezávisle od `pageSize`, inak by odznak
// zobrazoval len "1" namiesto skutočného počtu. Doteraz žiadny test
// nepoužil `pageSize` iný než predvolený, tento overuje presne ten
// predpoklad, na ktorom odznak stojí.
it("total sa počíta nad CELOU množinou nezávisle od pageSize — odznak v menu na tomto stojí", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedVariant(db, snapshotId, "RL-BADGE-1", "RL-BADGE-1/1", { name: "Bez linky Prvý", state: "out_of_stock" });
  await seedVariant(db, snapshotId, "RL-BADGE-2", "RL-BADGE-2/1", { name: "Bez linky Druhý", state: "out_of_stock" });

  const telo = (await (await app.request("/api/restock-links?q=RL-BADGE&page=1&pageSize=1", { headers: { cookie } })).json()) as Telo;
  expect(telo.total).toBe(2);
  expect(telo.items).toHaveLength(1);
});
