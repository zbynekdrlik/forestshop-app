import { afterEach, expect, it } from "vitest";
import { orderLines, orders, shopProductUrl } from "../src/db/schema.js";
import { listOpenOrderLinesBySupplier } from "../src/modules/orders/queries.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 276: majiteľ chce pod číslom objednávky aj kód produktu prelinkovaný
// na náš eshop. Adresa ide z `shop_product_url` (feed pre porovnávače, issue
// 220) — rovnaký zámer ako `nedostupne/queries.ts`'s `ourProductUrl` (issue
// 238): keď kód vo feede JE, `listOpenOrderLinesBySupplier` vráti jeho
// priamu adresu; keď NIE JE, vráti `null` (frontend to vykreslí ako
// neaktívny text, nikdy vyhľadávací fallback).

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

it("riadok, ktorého kód JE vo feede pre porovnávače, nesie priamu adresu produktu (ourUrl)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const db = ctx.db;

  await insertTestVariant(db, "A-1", "Dodávateľ Alfa");
  await db.insert(shopProductUrl).values({
    code: "A-1",
    url: "https://www.forestshop.sk/a-1/",
    fetchedAt: new Date("2026-08-05T09:00:00Z"),
  });

  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "9101", customerName: "Zákazník", statusName: "Vybavuje sa", placedAt: new Date("2026-08-01T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "A-1", quantity: 1 });

  const suppliers = await listOpenOrderLinesBySupplier(db, "https://test.example");
  const alfa = suppliers.find((s) => s.supplier === "Dodávateľ Alfa");
  expect(alfa?.lines.map((l) => l.ourUrl)).toEqual(["https://www.forestshop.sk/a-1/"]);
});

it("riadok, ktorého kód NIE JE vo feede pre porovnávače, dostane ourUrl: null (nikdy vyhľadávací fallback)", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const db = ctx.db;

  await insertTestVariant(db, "B-1", "Dodávateľ Bravo");

  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "9102", customerName: "Zákazník", statusName: "Vybavuje sa", placedAt: new Date("2026-08-01T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: "B-1", quantity: 1 });

  const suppliers = await listOpenOrderLinesBySupplier(db, "https://test.example");
  const bravo = suppliers.find((s) => s.supplier === "Dodávateľ Bravo");
  expect(bravo?.lines.map((l) => l.ourUrl)).toEqual([null]);
});
