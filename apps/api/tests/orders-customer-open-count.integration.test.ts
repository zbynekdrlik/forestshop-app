import { afterEach, expect, it } from "vitest";
import { orderLines, orders } from "../src/db/schema.js";
import { listOpenStatusNames } from "../src/modules/orders/open-statuses.js";
import { countOpenOrdersByCustomer, listOpenOrderLinesBySupplier } from "../src/modules/orders/queries.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 431: odznak s počtom OTVORENÝCH objednávok zákazníka v "Na objednanie".
// Overuje sa VÝPOČET počtu: Stornovaná/Vybavená sa NEPOČÍTA (nie sú v
// `order_open_status`, default "Vybavuje sa"), hranica 1 vs 2, a že identita
// zákazníka je zdieľaná s "Zlúčenie objednávok" (`customerIdentityKey` — email,
// inak meno pri hosťovskej objednávke bez e-mailu).

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

async function insertOrder(
  db: Awaited<ReturnType<typeof withCleanDb>>["db"],
  input: {
    externalOrderId: string;
    customerName: string;
    email: string | null;
    statusName: string;
    variantCode: string;
  },
): Promise<void> {
  const [objednavka] = await db
    .insert(orders)
    .values({
      externalOrderId: input.externalOrderId,
      customerName: input.customerName,
      email: input.email,
      statusName: input.statusName,
      placedAt: new Date("2026-08-10T00:00:00Z"),
    })
    .returning();
  if (objednavka === undefined) throw new Error("insert objednávky zlyhal");
  await db.insert(orderLines).values({ orderId: objednavka.id, variantCode: input.variantCode, quantity: 1 });
}

it("počíta len OTVORENÉ objednávky na zákazníka — Stornovaná/Vybavená sa nepočíta, hranica 1 vs 2", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const db = ctx.db;

  await insertTestVariant(db, "V-1", "Dodávateľ Alfa");
  await insertTestVariant(db, "V-2", "Dodávateľ Bravo");

  // Zákazník s e-mailom: 2 otvorené ("Vybavuje sa") + 1 Stornovaná + 1 Vybavená.
  await insertOrder(db, { externalOrderId: "5001", customerName: "Juraj Petro", email: "juraj@example.sk", statusName: "Vybavuje sa", variantCode: "V-1" });
  await insertOrder(db, { externalOrderId: "5002", customerName: "Juraj Petro", email: "juraj@example.sk", statusName: "Vybavuje sa", variantCode: "V-2" });
  await insertOrder(db, { externalOrderId: "5003", customerName: "Juraj Petro", email: "juraj@example.sk", statusName: "Stornovaná", variantCode: "V-1" });
  await insertOrder(db, { externalOrderId: "5004", customerName: "Juraj Petro", email: "juraj@example.sk", statusName: "Vybavená", variantCode: "V-2" });
  // Iný zákazník: jediná otvorená objednávka → hranica 1 (bez odznaku).
  await insertOrder(db, { externalOrderId: "5005", customerName: "Anna Nová", email: "anna@example.sk", statusName: "Vybavuje sa", variantCode: "V-1" });
  // Hosť bez e-mailu: 2 otvorené → identita podľa mena (fallback).
  await insertOrder(db, { externalOrderId: "5006", customerName: "Hosť Bezmail", email: null, statusName: "Vybavuje sa", variantCode: "V-1" });
  await insertOrder(db, { externalOrderId: "5007", customerName: "Hosť Bezmail", email: null, statusName: "Vybavuje sa", variantCode: "V-2" });

  const openStatuses = await listOpenStatusNames(db);
  const counts = await countOpenOrdersByCustomer(db, openStatuses);

  // Kľúč = `customerIdentityKey(email, customerName)` — email má prednosť.
  expect(counts.get("email:juraj@example.sk")).toBe(2); // Stornovaná ani Vybavená sa nezarátali
  expect(counts.get("email:anna@example.sk")).toBe(1);
  expect(counts.get("name:hosť bezmail")).toBe(2);
});

it("listOpenOrderLinesBySupplier priloží customerOpenOrderCount ku každému riadku", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const db = ctx.db;

  await insertTestVariant(db, "V-1", "Dodávateľ Alfa");
  await insertTestVariant(db, "V-2", "Dodávateľ Bravo");

  await insertOrder(db, { externalOrderId: "6001", customerName: "Juraj Petro", email: "juraj@example.sk", statusName: "Vybavuje sa", variantCode: "V-1" });
  await insertOrder(db, { externalOrderId: "6002", customerName: "Juraj Petro", email: "juraj@example.sk", statusName: "Vybavuje sa", variantCode: "V-2" });
  await insertOrder(db, { externalOrderId: "6003", customerName: "Juraj Petro", email: "juraj@example.sk", statusName: "Stornovaná", variantCode: "V-1" });
  await insertOrder(db, { externalOrderId: "6004", customerName: "Anna Nová", email: "anna@example.sk", statusName: "Vybavuje sa", variantCode: "V-1" });

  const suppliers = await listOpenOrderLinesBySupplier(db, "https://test.example");
  const byExternalId = new Map<string, number>();
  for (const group of suppliers) {
    for (const line of group.lines) byExternalId.set(line.externalOrderId, line.customerOpenOrderCount);
  }

  // Stornovaná (6003) sa v otvorených riadkoch vôbec neobjaví.
  expect(byExternalId.has("6003")).toBe(false);
  // Obe otvorené objednávky Juraja Petra nesú count 2; Anna má count 1.
  expect(byExternalId.get("6001")).toBe(2);
  expect(byExternalId.get("6002")).toBe(2);
  expect(byExternalId.get("6004")).toBe(1);
});
