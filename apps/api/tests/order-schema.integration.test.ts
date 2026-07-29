import { eq, sql } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { orderLines, orders, products, variants } from "../src/db/schema.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";
import type { Database } from "../src/db/client.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const NOW = new Date("2026-07-29T10:00:00Z");

/** Vloží presne jeden produkt + variant, na ktoré sa dá referencovať z order_line. */
async function insertTestVariant(db: Database, code: string): Promise<void> {
  const snapshotId = await insertTestSnapshot(db);
  await db.insert(products).values({
    key: code,
    name: "Nohavice FOREST 1003",
    supplier: "Test dodávateľ",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastSeenSnapshotId: snapshotId,
  });
  await db.insert(variants).values({
    code,
    productKey: code,
    guid: code,
    sizeLabel: "XL",
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

it("uloží objednávku a riadok a prečíta ich späť, s predvoleným stavom 'objednane'", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await insertTestVariant(ctx.db, "40237/XL");

  const [order] = await ctx.db
    .insert(orders)
    .values({
      externalOrderId: "SHOPTET-1001",
      customerName: "Ján Novák",
      comment: "Zavolať pred doručením",
      placedAt: NOW,
    })
    .returning();
  if (order === undefined) throw new Error("insert order zlyhal");

  await ctx.db.insert(orderLines).values({
    orderId: order.id,
    variantCode: "40237/XL",
    quantity: 2,
  });

  const lines = await ctx.db.select().from(orderLines).where(eq(orderLines.orderId, order.id));
  expect(lines).toHaveLength(1);
  expect(lines[0]?.quantity).toBe(2);
  expect(lines[0]?.state).toBe("objednane");
  expect(lines[0]?.variantCode).toBe("40237/XL");

  const readOrder = await ctx.db.select().from(orders).where(eq(orders.id, order.id));
  expect(readOrder[0]?.externalOrderId).toBe("SHOPTET-1001");
  expect(readOrder[0]?.comment).toBe("Zavolať pred doručením");
});

it("umožní prechod riadku medzi všetkými štyrmi stavmi automatu", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await insertTestVariant(ctx.db, "40238/M");
  const [order] = await ctx.db
    .insert(orders)
    .values({ externalOrderId: "SHOPTET-1002", customerName: "Eva Malá", placedAt: NOW })
    .returning();
  if (order === undefined) throw new Error("insert order zlyhal");
  const [line] = await ctx.db
    .insert(orderLines)
    .values({ orderId: order.id, variantCode: "40238/M", quantity: 1 })
    .returning();
  if (line === undefined) throw new Error("insert order_line zlyhal");

  for (const state of ["caka_sa", "skladom", "nedostupne"] as const) {
    await ctx.db.update(orderLines).set({ state }).where(eq(orderLines.id, line.id));
    const rows = await ctx.db.select().from(orderLines).where(eq(orderLines.id, line.id));
    expect(rows[0]?.state).toBe(state);
  }
});

it("odmietne riadok s neexistujúcim variantom (FK)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const [order] = await ctx.db
    .insert(orders)
    .values({ externalOrderId: "SHOPTET-1003", customerName: "Peter Suchý", placedAt: NOW })
    .returning();
  if (order === undefined) throw new Error("insert order zlyhal");

  await expect(
    ctx.db.insert(orderLines).values({ orderId: order.id, variantCode: "neexistujuci-kod", quantity: 1 }),
  ).rejects.toThrow(/order_line_variant_code_variant_code_fk/);
});

it("odmietne nekladné množstvo (CHECK)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await insertTestVariant(ctx.db, "40239/S");
  const [order] = await ctx.db
    .insert(orders)
    .values({ externalOrderId: "SHOPTET-1004", customerName: "Zuzana Krátka", placedAt: NOW })
    .returning();
  if (order === undefined) throw new Error("insert order zlyhal");

  await expect(
    ctx.db.insert(orderLines).values({ orderId: order.id, variantCode: "40239/S", quantity: 0 }),
  ).rejects.toThrow(/order_line_quantity_positive_ck/);
  await expect(
    ctx.db.insert(orderLines).values({ orderId: order.id, variantCode: "40239/S", quantity: -3 }),
  ).rejects.toThrow(/order_line_quantity_positive_ck/);
});

it("odmietne stav mimo automatu (enum)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await insertTestVariant(ctx.db, "40240/L");
  const [order] = await ctx.db
    .insert(orders)
    .values({ externalOrderId: "SHOPTET-1005", customerName: "Milan Veľký", placedAt: NOW })
    .returning();
  if (order === undefined) throw new Error("insert order zlyhal");

  await expect(
    ctx.db.execute(sql`
      INSERT INTO order_line (order_id, variant_code, quantity, state)
      VALUES (${order.id}, '40240/L', 1, 'zrusene')
    `),
  ).rejects.toThrow(/invalid input value for enum order_line_state/);
});

it("odmietne druhú objednávku s rovnakým external_order_id (UNIQUE)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db
    .insert(orders)
    .values({ externalOrderId: "SHOPTET-1006", customerName: "Prvá zákazníčka", placedAt: NOW });

  await expect(
    ctx.db
      .insert(orders)
      .values({ externalOrderId: "SHOPTET-1006", customerName: "Druhý zákazník", placedAt: NOW }),
  ).rejects.toThrow(/order_external_order_id_unique/);
});

it("zmaže riadky objednávky, keď sa zmaže objednávka (CASCADE)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await insertTestVariant(ctx.db, "40241/2XL");
  const [order] = await ctx.db
    .insert(orders)
    .values({ externalOrderId: "SHOPTET-1007", customerName: "Katarína Nízka", placedAt: NOW })
    .returning();
  if (order === undefined) throw new Error("insert order zlyhal");
  await ctx.db.insert(orderLines).values({ orderId: order.id, variantCode: "40241/2XL", quantity: 1 });

  await ctx.db.delete(orders).where(eq(orders.id, order.id));

  const remaining = await ctx.db.select().from(orderLines).where(eq(orderLines.orderId, order.id));
  expect(remaining).toHaveLength(0);
});

it("NEzmaže objednávku, keď sa zmaže referencovaný variant (bez onDelete = RESTRICT)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await insertTestVariant(ctx.db, "40242/M");
  const [order] = await ctx.db
    .insert(orders)
    .values({ externalOrderId: "SHOPTET-1008", customerName: "Tomáš Dlhý", placedAt: NOW })
    .returning();
  if (order === undefined) throw new Error("insert order zlyhal");
  await ctx.db.insert(orderLines).values({ orderId: order.id, variantCode: "40242/M", quantity: 1 });

  await expect(ctx.db.delete(variants).where(eq(variants.code, "40242/M"))).rejects.toThrow(
    /order_line_variant_code_variant_code_fk/,
  );
});
