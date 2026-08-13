// issue 387 E3: výber produktov pre gather beh — "iba produkty bez
// efektívneho odkazu, ktoré nemajú kandidátov alebo majú zmenený
// input_hash; prioritne vypredané-viditeľné" (návrh, sekcia 5 bod 3).
//
// Rovnaký MVP vzor ako `product-links/queries.ts`'s `listProductLinks`/
// `restock-links/queries.ts`'s `listRestockLinkSuggestions` — celý katalóg
// (rádovo tisícky produktov) sa načíta a filtruje v pamäti, nie SQL JOIN so
// vstavaným hashovaním (input_hash porovnanie je nutne JS-side, keďže
// `computeInputHash` je čistá JS funkcia).

import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairingCandidateSets, productSupplierLinkOverrides, products, suppliers, variants } from "../../db/schema.js";
import { resolveEffectiveSupplierLink } from "../orders/effective-supplier-link.js";
import { normalizeSupplierKeyJs } from "../orders/supplier-key.js";
import { SELLABLE_VISIBILITY } from "../restock/constants.js";
import { computeInputHash } from "./input-hash.js";
import { toPairingProduct, type PairingProduct } from "./types.js";

export interface EligibleProduct {
  readonly product: PairingProduct;
  readonly adapterKey: string;
  readonly inputHash: string;
  /** "vypredané-viditeľné" — rovnaká populácia ako #311 (`variant.state ===
   * "out_of_stock" && productVisibility === "visible" && missingSince ===
   * null`), zoradené PRED ostatnými (design: "prioritne"). */
  readonly soldOutVisible: boolean;
}

export async function selectEligibleProducts(db: Database): Promise<readonly EligibleProduct[]> {
  const supplierRows = await db.select({ name: suppliers.name, adapterKey: suppliers.adapterKey }).from(suppliers);
  const adapterByNormalizedSupplier = new Map<string, string>();
  for (const row of supplierRows) {
    if (row.adapterKey !== null) adapterByNormalizedSupplier.set(normalizeSupplierKeyJs(row.name), row.adapterKey);
  }
  // Bez ANI JEDNÉHO dodávateľa so známym adaptérom (napr. čerstvá DB pred
  // migračným seedom) niet zmysel čítať zvyšok katalógu vôbec.
  if (adapterByNormalizedSupplier.size === 0) return [];

  const productRows = await db
    .select({
      key: products.key,
      name: products.name,
      supplier: products.supplier,
      internalNote: products.internalNote,
      overrideUrl: productSupplierLinkOverrides.url,
    })
    .from(products)
    .leftJoin(productSupplierLinkOverrides, eq(productSupplierLinkOverrides.productKey, products.key));

  const variantRows = await db
    .select({
      productKey: variants.productKey,
      externalCode: variants.externalCode,
      state: variants.state,
      productVisibility: variants.productVisibility,
      missingSince: variants.missingSince,
    })
    .from(variants);
  const variantsByProduct = new Map<string, typeof variantRows>();
  for (const row of variantRows) {
    const bucket = variantsByProduct.get(row.productKey);
    if (bucket === undefined) variantsByProduct.set(row.productKey, [row]);
    else bucket.push(row);
  }

  const hashRows = await db.select({ productKey: pairingCandidateSets.productKey, inputHash: pairingCandidateSets.inputHash }).from(pairingCandidateSets);
  const hashByProduct = new Map(hashRows.map((row) => [row.productKey, row.inputHash]));

  const eligible: EligibleProduct[] = [];
  for (const row of productRows) {
    const effective = resolveEffectiveSupplierLink(row.internalNote, row.overrideUrl);
    if (effective.url !== null) continue;

    const adapterKey = adapterByNormalizedSupplier.get(normalizeSupplierKeyJs(row.supplier ?? ""));
    if (adapterKey === undefined) continue;

    const productVariants = variantsByProduct.get(row.key) ?? [];
    const pairingProduct = toPairingProduct(
      { key: row.key, name: row.name, supplier: row.supplier },
      productVariants.map((v) => ({ externalCode: v.externalCode })),
    );
    const inputHash = computeInputHash(pairingProduct);
    if (hashByProduct.get(row.key) === inputHash) continue;

    const soldOutVisible = productVariants.some(
      (v) => v.state === "out_of_stock" && v.productVisibility === SELLABLE_VISIBILITY && v.missingSince === null,
    );
    eligible.push({ product: pairingProduct, adapterKey, inputHash, soldOutVisible });
  }

  eligible.sort((a, b) => Number(b.soldOutVisible) - Number(a.soldOutVisible) || a.product.productKey.localeCompare(b.product.productKey));
  return eligible;
}
