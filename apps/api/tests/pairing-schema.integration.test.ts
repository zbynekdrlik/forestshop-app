import { sql } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { pairings, products, suppliers, users, variants } from "../src/db/schema.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";
import type { Database } from "../src/db/client.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const NOW = new Date("2026-07-30T10:00:00Z");

/** Vloží presne jeden produkt + variant, na ktoré sa dá referencovať z pairing. */
async function insertTestVariant(db: Database, code: string): Promise<void> {
  const snapshotId = await insertTestSnapshot(db);
  await db.insert(products).values({
    key: code,
    name: "Nohavice FOREST 1003",
    supplier: "GRUBE",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastSeenSnapshotId: snapshotId,
  });
  await db.insert(variants).values({
    code,
    productKey: code,
    guid: code,
    sizeLabel: "L",
    pairCode: "1",
    name: "Nohavice FOREST 1003",
    currency: "EUR",
    price: "62.76",
    standardPrice: "66.08",
    purchasePrice: null,
    actionPrice: null,
    actionFrom: null,
    actionUntil: null,
    percentVat: "23.00",
    includingVat: true,
    stock: 5,
    availabilityInStockText: "Skladom",
    availabilityOutOfStockText: "Není skladem",
    availabilityText: "Skladom",
    productVisibility: "visible",
    state: "sellable",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastSeenSnapshotId: snapshotId,
    missingSince: null,
  });
}

/** Vloží testovacieho manažéra, na ktorého sa dá referencovať z pairing.confirmed_by. */
async function insertTestUser(db: Database, email: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({
      email,
      // Literál, nie skutočný argon2 hash — tento test súbor overuje len
      // schému/obmedzenia pairingu, nikdy prihlasovací tok.
      passwordHash: "not-a-real-hash",
      displayName: "Test manažér",
      role: "manazer",
    })
    .returning({ id: users.id });
  if (row === undefined) throw new Error("Testovacieho manažéra sa nepodarilo vložiť");
  return row.id;
}

it("uloží dodávateľa a prečíta ho späť", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(suppliers).values({
    name: "GRUBE",
    currency: "EUR",
    wholesaleBaseUrl: "https://www.grube.de/",
    adapterKey: "grube",
  });

  const rows = await ctx.db.select().from(suppliers);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.name).toBe("GRUBE");
  expect(rows[0]?.currency).toBe("EUR");
  expect(rows[0]?.adapterKey).toBe("grube");
});

it("dovolí dodávateľa bez veľkoobchodnej URL a bez adaptéra (obe nullable)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(suppliers).values({
    name: "Ručný dodávateľ",
    currency: "EUR",
    wholesaleBaseUrl: null,
    adapterKey: null,
  });

  const rows = await ctx.db.select().from(suppliers);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.wholesaleBaseUrl).toBeNull();
  expect(rows[0]?.adapterKey).toBeNull();
});

it("odmietne druhého dodávateľa s rovnakým menom (PK)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(suppliers).values({ name: "WETLAND", currency: "EUR" });
  await expect(ctx.db.insert(suppliers).values({ name: "WETLAND", currency: "CZK" })).rejects.toThrow(
    /duplicate key value violates unique constraint "supplier_pkey"/,
  );
});

it("odmietne dodávateľa bez meny (NOT NULL)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await expect(
    ctx.db.execute(sql`INSERT INTO supplier (name, currency) VALUES ('Bez meny', NULL)`),
  ).rejects.toThrow(/null value in column "currency"/);
});

it("uloží pairing pre variant s predvoleným stavom 'navrhnute' a prečíta ho späť", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await insertTestVariant(ctx.db, "40237/L");

  await ctx.db.insert(pairings).values({
    variantCode: "40237/L",
    supplierUrl: "https://www.grube.sk/p/nohavice-forest-1003/154773/",
  });

  const rows = await ctx.db.select().from(pairings);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe("navrhnute");
  expect(rows[0]?.confirmedBy).toBeNull();
  expect(rows[0]?.confirmedAt).toBeNull();
});

it("uloží POTVRDENÝ pairing s confirmed_by a confirmed_at vyplnenými", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await insertTestVariant(ctx.db, "40238/M");
  const userId = await insertTestUser(ctx.db, "manazer-pairing@forestshop.sk");
  const confirmedAt = new Date("2026-07-30T11:00:00Z");

  await ctx.db.insert(pairings).values({
    variantCode: "40238/M",
    supplierUrl: "https://www.grube.sk/p/nohavice-forest-1003/154773/",
    state: "potvrdene",
    confirmedBy: userId,
    confirmedAt,
  });

  const rows = await ctx.db.select().from(pairings);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe("potvrdene");
  expect(rows[0]?.confirmedBy).toBe(userId);
  expect(rows[0]?.confirmedAt).toEqual(confirmedAt);
});

it("odmietne DRUHÝ pairing pre ten istý variant (UNIQUE) — jadro opravy #44", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await insertTestVariant(ctx.db, "40239/S");
  await ctx.db.insert(pairings).values({ variantCode: "40239/S", supplierUrl: "https://a.example/1" });

  await expect(
    ctx.db.insert(pairings).values({ variantCode: "40239/S", supplierUrl: "https://a.example/2" }),
  ).rejects.toThrow(/pairing_variant_code_unique/);
});

it("dovolí pairing pre DVA RÔZNE varianty toho istého produktu (dve veľkosti sa potvrdzujú nezávisle)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await insertTestVariant(ctx.db, "40240/S");
  await insertTestVariant(ctx.db, "40240/M");
  const userId = await insertTestUser(ctx.db, "manazer-dve-velkosti@forestshop.sk");

  await ctx.db.insert(pairings).values({
    variantCode: "40240/S",
    state: "potvrdene",
    confirmedBy: userId,
    confirmedAt: NOW,
  });
  // Druhá veľkosť ZOSTÁVA nepotvrdená — presne to, čo v starej appke (per-produkt
  // JSON) nebolo možné: obe veľkosti museli zdieľať jeden spoločný stav.
  await ctx.db.insert(pairings).values({ variantCode: "40240/M" });

  const rows = await ctx.db.select().from(pairings).orderBy(pairings.variantCode);
  expect(rows).toHaveLength(2);
  expect(rows[0]?.variantCode).toBe("40240/M");
  expect(rows[0]?.state).toBe("navrhnute");
  expect(rows[1]?.variantCode).toBe("40240/S");
  expect(rows[1]?.state).toBe("potvrdene");
});

it("odmietne pairing s neexistujúcim variantom (FK)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await expect(
    ctx.db.insert(pairings).values({ variantCode: "neexistujuci-kod" }),
  ).rejects.toThrow(/pairing_variant_code_variant_code_fk/);
});

it("odmietne stav mimo automatu (enum)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await insertTestVariant(ctx.db, "40241/XL");
  await expect(
    ctx.db.execute(sql`
      INSERT INTO pairing (variant_code, state) VALUES ('40241/XL', 'zamietnute')
    `),
  ).rejects.toThrow(/invalid input value for enum pairing_state/);
});

it("odmietne 'potvrdene' bez confirmed_by/confirmed_at (CHECK)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await insertTestVariant(ctx.db, "40242/2XL");
  await expect(
    ctx.db.insert(pairings).values({ variantCode: "40242/2XL", state: "potvrdene" }),
  ).rejects.toThrow(/pairing_confirmation_ck/);
});

it("odmietne 'navrhnute' S vyplneným confirmed_by/confirmed_at (CHECK, opačný smer)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await insertTestVariant(ctx.db, "40243/3XL");
  const userId = await insertTestUser(ctx.db, "manazer-check-opacny-smer@forestshop.sk");
  await expect(
    ctx.db.insert(pairings).values({
      variantCode: "40243/3XL",
      state: "navrhnute",
      confirmedBy: userId,
      confirmedAt: NOW,
    }),
  ).rejects.toThrow(/pairing_confirmation_ck/);
});

it("NEzmaže pairing, keď sa zmaže potvrdzujúci používateľ — len stratí odkaz (onDelete: set null)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await insertTestVariant(ctx.db, "40244/4XL");
  const userId = await insertTestUser(ctx.db, "manazer-mazany@forestshop.sk");
  await ctx.db.insert(pairings).values({
    variantCode: "40244/4XL",
    state: "potvrdene",
    confirmedBy: userId,
    confirmedAt: NOW,
  });

  // Zmazanie používateľa priamo cez SQL — smie porušiť CHECK (potvrdene bez
  // confirmed_by) len vtedy, ak by set null nefungoval; over, že sa namiesto
  // toho zmaže samotný riadok pairing (set null by inak vytvoril nekonzistentný
  // stav, ktorý CHECK odmieta — takže onDelete tu MUSÍ byť "cascade" na úrovni
  // riadku pairing, nie len set null na stĺpci). Skutočné správanie: Postgres
  // ON DELETE SET NULL na `confirmed_by` by porušilo `pairing_confirmation_ck`
  // (potvrdene vyžaduje confirmed_by vyplnené) — DB preto zmazanie POUŽÍVATEĽA
  // odmietne, kým je naň napojený potvrdený pairing.
  await expect(
    ctx.db.execute(sql`DELETE FROM users WHERE id = ${userId}`),
  ).rejects.toThrow(/pairing_confirmation_ck/);
});
