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
 * musí zvládnuť aj tento prípad. Nepovinný `options` (issue 67) — odkaz na
 * dodávateľa (`internalNote`) a kód u dodávateľa (`externalCode`), oba
 * predvolene `null` (existujúce volania sa nemenia).
 */
export async function insertTestVariant(
  db: Database,
  code: string,
  supplier: string | null = "Test dodávateľ",
  options: { readonly internalNote?: string | null; readonly externalCode?: string | null } = {},
): Promise<void> {
  const snapshotId = await insertTestSnapshot(db);
  await db.insert(products).values({
    key: code,
    name: `Test produkt ${code}`,
    supplier,
    internalNote: options.internalNote ?? null,
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
    externalCode: options.externalCode ?? null,
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

/**
 * Vloží JEDEN variant (veľkosť) patriaci k VIACVARIANTNÉMU produktu — na
 * rozdiel od `insertTestVariant` (ktorá vždy vytvorí NOVÝ produkt, kľúčovaný
 * samotným `code`) tu volajúci sám zadá zdieľaný `productKey`, takže
 * viacero volaní so ROVNAKÝM `productKey` a RÔZNYMI `code` vytvorí presne
 * to, čo issue 47 (F4 rozdelenie podľa veľkostí) potrebuje testovať:
 * zoskupenie `apps/api/src/modules/pairing/queries.ts`'s `listPairings()`
 * podľa produktu. `.onConflictDoNothing()` na produkte — DRUHÉ a ďalšie
 * volanie pre ten istý `productKey` zámerne NEPREPÍŠE už vložený riadok
 * produktu (rovnaký produkt, len iný variant).
 */
export async function insertTestVariantForProduct(
  db: Database,
  productKey: string,
  code: string,
  options: { readonly sizeLabel?: string | null; readonly supplier?: string | null; readonly productName?: string } = {},
): Promise<void> {
  const snapshotId = await insertTestSnapshot(db);
  await db
    .insert(products)
    .values({
      key: productKey,
      name: options.productName ?? `Test produkt ${productKey}`,
      // issue 63: `??` by "opravilo" aj VÝSLOVNE zadané `supplier: null` späť
      // na default — `??` fallbackuje na `undefined` AJ `null` rovnako.
      // Explicitný `"supplier" in options` rozlíši "kľúč vôbec nezadaný"
      // (default "Test dodávateľ") od "zadané ako null" (skutočne bez
      // dodávateľa — potrebné pre testy ručného priradenia dodávateľa).
      supplier: "supplier" in options ? options.supplier : "Test dodávateľ",
      firstSeenAt: new Date("2026-01-01T00:00:00Z"),
      lastSeenAt: new Date("2026-01-01T00:00:00Z"),
      lastSeenSnapshotId: snapshotId,
    })
    .onConflictDoNothing();
  await db.insert(variants).values({
    code,
    productKey,
    guid: productKey,
    sizeLabel: options.sizeLabel ?? null,
    pairCode: null,
    name: options.productName ?? `Test produkt ${productKey}`,
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
