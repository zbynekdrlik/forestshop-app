import { sql } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { products, variants } from "../src/db/schema.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const NOW = new Date("2026-07-29T10:00:00Z");

it("uloží snapshot, produkt a variant a prečíta ich späť", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const snapshotId = await insertTestSnapshot(ctx.db);

  await ctx.db.insert(products).values({
    key: "40237",
    name: "Nohavice FOREST 1003",
    supplier: null,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastSeenSnapshotId: snapshotId,
  });
  await ctx.db.insert(variants).values({
    code: "40237/3XL",
    productKey: "40237",
    guid: "40237",
    sizeLabel: "3XL",
    pairCode: "1",
    name: "Nohavice FOREST 1003",
    currency: "EUR",
    price: "67.00",
    standardPrice: "71.00",
    purchasePrice: "32.68",
    actionPrice: null,
    actionFrom: null,
    actionUntil: null,
    percentVat: "23.00",
    includingVat: true,
    stock: -11,
    availabilityInStockText: "Predaj výrobku skončil",
    availabilityOutOfStockText: "Predaj výrobku skončil",
    availabilityText: "Predaj výrobku skončil",
    productVisibility: "visible",
    state: "discontinued",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastSeenSnapshotId: snapshotId,
    missingSince: null,
  });

  const rows = await ctx.db.select().from(variants);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.price).toBe("67.00");
  expect(rows[0]?.state).toBe("discontinued");
});

it("odmietne sumu bez meny (CHECK)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const snapshotId = await insertTestSnapshot(ctx.db);
  await ctx.db.insert(products).values({
    key: "40287",
    name: "Čiapka Polar FOREST",
    supplier: null,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastSeenSnapshotId: snapshotId,
  });

  await expect(
    ctx.db.insert(variants).values({
      code: "40287",
      productKey: "40287",
      guid: "40287",
      sizeLabel: null,
      pairCode: null,
      name: "Čiapka Polar FOREST",
      currency: null, // suma je, mena nie → CHECK musí zabrať
      price: "9.00",
      standardPrice: null,
      purchasePrice: null,
      actionPrice: null,
      actionFrom: null,
      actionUntil: null,
      percentVat: null,
      includingVat: null,
      stock: -111,
      availabilityInStockText: "Skladom",
      availabilityOutOfStockText: "Skladom",
      availabilityText: "Skladom",
      productVisibility: "detailOnly",
      state: "sellable",
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      lastSeenSnapshotId: snapshotId,
      missingSince: null,
    }),
  ).rejects.toThrow(/variant_money_needs_currency_ck/);
});

it("odmietne prázdny reťazec ako menu, keď je suma vyplnená (CHECK)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const snapshotId = await insertTestSnapshot(ctx.db);
  await ctx.db.insert(products).values({
    key: "40288",
    name: "Šál FOREST",
    supplier: null,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastSeenSnapshotId: snapshotId,
  });

  await expect(
    ctx.db.insert(variants).values({
      code: "40288",
      productKey: "40288",
      guid: "40288",
      sizeLabel: null,
      pairCode: null,
      name: "Šál FOREST",
      currency: "", // prázdny reťazec nie je NULL — CHECK ho musí odmietnuť rovnako prísne
      price: "67.00",
      standardPrice: null,
      purchasePrice: null,
      actionPrice: null,
      actionFrom: null,
      actionUntil: null,
      percentVat: null,
      includingVat: null,
      stock: 5,
      availabilityInStockText: "Skladom",
      availabilityOutOfStockText: "Skladom",
      availabilityText: "Skladom",
      productVisibility: "detailOnly",
      state: "sellable",
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      lastSeenSnapshotId: snapshotId,
      missingSince: null,
    }),
  ).rejects.toThrow(/variant_money_needs_currency_ck/);
});

it("odmietne druhý variant s rovnakým kódom", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const snapshotId = await insertTestSnapshot(ctx.db);
  await ctx.db.insert(products).values({
    key: "278",
    name: "ThermVisia objímka",
    supplier: null,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastSeenSnapshotId: snapshotId,
  });
  const variant = {
    code: "278",
    productKey: "278",
    guid: "278",
    sizeLabel: null,
    pairCode: null,
    name: "ThermVisia objímka",
    currency: "EUR",
    price: "1249.00",
    standardPrice: "1249.00",
    purchasePrice: null,
    actionPrice: null,
    actionFrom: null,
    actionUntil: null,
    percentVat: "23.00",
    includingVat: true,
    stock: 0,
    availabilityInStockText: "",
    availabilityOutOfStockText: "Není skladem",
    availabilityText: "Není skladem",
    productVisibility: "detailOnly",
    state: "out_of_stock" as const,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastSeenSnapshotId: snapshotId,
    missingSince: null,
  };
  await ctx.db.insert(variants).values(variant);
  await expect(ctx.db.insert(variants).values(variant)).rejects.toThrow(
    /duplicate key value violates unique constraint "variant_pkey"/,
  );
});

it("odmietne iný verdikt než accepted/rejected", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await expect(
    ctx.db.execute(sql`
      INSERT INTO catalog_snapshot
        (fetched_at, source_label, content_sha256, byte_size, row_count, columns, verdict)
      VALUES (now(), 'test', 'sha-x', 10, 10, '["code"]'::jsonb, 'maybe')
    `),
  ).rejects.toThrow(/invalid input value for enum snapshot_verdict/);
});

it("prijatý snapshot nesmie mať dôvod odmietnutia a odmietnutý ho mať musí", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await expect(
    insertTestSnapshot(ctx.db, { verdict: "rejected", rejectionReason: null, contentSha256: "sha-r" }),
  ).rejects.toThrow(/catalog_snapshot_reason_ck/);
  await expect(
    insertTestSnapshot(ctx.db, { verdict: "accepted", rejectionReason: "nemá tu byť", contentSha256: "sha-a" }),
  ).rejects.toThrow(/catalog_snapshot_reason_ck/);
});

it("odmietne druhý PRIJATÝ snapshot s rovnakým obsahovým hashom", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await insertTestSnapshot(ctx.db, { verdict: "accepted", contentSha256: "sha-dup-accepted" });
  await expect(
    insertTestSnapshot(ctx.db, { verdict: "accepted", contentSha256: "sha-dup-accepted" }),
  ).rejects.toThrow(/catalog_snapshot_accepted_sha_uq/);
});

it("dovolí dva ODMIETNUTÉ snapshoty s rovnakým obsahovým hashom (index je len na accepted)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const first = await insertTestSnapshot(ctx.db, {
    verdict: "rejected",
    rejectionReason: "prázdny export",
    contentSha256: "sha-dup-rejected",
  });
  const second = await insertTestSnapshot(ctx.db, {
    verdict: "rejected",
    rejectionReason: "prázdny export",
    contentSha256: "sha-dup-rejected",
  });
  expect(first).not.toBe(second);
});

it("dovolí variant bez meny, keď žiadna suma nie je vyplnená (CHECK to má povoliť)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const snapshotId = await insertTestSnapshot(ctx.db);
  await ctx.db.insert(products).values({
    key: "40289",
    name: "Ponožky FOREST",
    supplier: null,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastSeenSnapshotId: snapshotId,
  });

  // Presne to, čo mapper vyprodukuje, keď parsovanie peňazí zlyhá — currency aj
  // všetky 4 sumy NULL. Ak by niekto CHECK zjednodušil na holé `currency IS NOT
  // NULL`, tento insert by začal padať a ďalšia úloha by narazila na stenu.
  await ctx.db.insert(variants).values({
    code: "40289",
    productKey: "40289",
    guid: "40289",
    sizeLabel: null,
    pairCode: null,
    name: "Ponožky FOREST",
    currency: null,
    price: null,
    standardPrice: null,
    purchasePrice: null,
    actionPrice: null,
    actionFrom: null,
    actionUntil: null,
    percentVat: null,
    includingVat: null,
    stock: 0,
    availabilityInStockText: "Skladom",
    availabilityOutOfStockText: "Skladom",
    availabilityText: "Skladom",
    productVisibility: "detailOnly",
    state: "sellable",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastSeenSnapshotId: snapshotId,
    missingSince: null,
  });

  const rows = await ctx.db.select().from(variants);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.currency).toBeNull();
  expect(rows[0]?.price).toBeNull();
});
