import type { Database } from "../../src/db/client.js";
import { products, variants } from "../../src/db/schema.js";
import { insertTestSnapshot } from "./catalog.js";

/**
 * Vloží presne jeden produkt + variant, na ktoré sa dá referencovať z
 * `order_line` — orders-ingest testy potrebujú aspoň jeden ZNÁMY variant, aby
 * import mohol skutočne zapísať riadok (neznáme varianty sa inak ticho
 * preskočia, `orders/ingest.ts`'s `knownVariantCodes` kontrola). Nepovinný
 * `supplier` (#23) — testy zoskupenia "Na objednanie" podľa dodávateľa
 * potrebujú aspoň dvoch RÔZNYCH dodávateľov, predvolená hodnota zostáva
 * rovnaká ako doteraz, takže existujúce volania sa nemenia. `null` je
 * explicitne povolené (nie len string) — `product.supplier` je v schéme
 * nepovinný stĺpec (`.claude/rules/orders.md`) a `queries.ts`'s zoskupenie
 * musí zvládnuť aj tento prípad.
 */
export async function insertTestVariant(
  db: Database,
  code: string,
  supplier: string | null = "Test dodávateľ",
): Promise<void> {
  const snapshotId = await insertTestSnapshot(db);
  await db.insert(products).values({
    key: code,
    name: `Test produkt ${code}`,
    supplier,
    firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    lastSeenAt: new Date("2026-01-01T00:00:00Z"),
    lastSeenSnapshotId: snapshotId,
  });
  await db.insert(variants).values({
    code,
    productKey: code,
    guid: code,
    sizeLabel: null,
    pairCode: null,
    name: `Test produkt ${code}`,
    currency: "EUR",
    price: "10.00",
    standardPrice: null,
    purchasePrice: null,
    actionPrice: null,
    actionFrom: null,
    actionUntil: null,
    percentVat: null,
    includingVat: null,
    stock: 5,
    availabilityInStockText: "Skladom",
    availabilityOutOfStockText: "Není skladem",
    availabilityText: "Skladom",
    productVisibility: "visible",
    state: "sellable",
    firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    lastSeenAt: new Date("2026-01-01T00:00:00Z"),
    lastSeenSnapshotId: snapshotId,
    missingSince: null,
  });
}
