import { afterEach, expect, it } from "vitest";
import { products, users, variants } from "../src/db/schema.js";
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

it("produkt s efektívnou linkou (aj cez override) sa v zozname nezobrazí", async () => {
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
