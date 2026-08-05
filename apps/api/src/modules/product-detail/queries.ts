import { asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { productSupplierLinkOverrides, products, shopProductUrl, supplierStock, variants } from "../../db/schema.js";
import type { VariantState } from "../catalog/availability.js";
import { extractSupplierLink } from "../catalog/supplier-link.js";
import { resolveEffectiveSupplierLink } from "../orders/effective-supplier-link.js";

// issue 240: detail produktu za výsledkom hľadania — VŠETKY varianty
// (veľkosti) toho istého produktu naraz, efektívna dodávateľská linka + jej
// uložené/odoslané časy (rovnaká `resolveEffectiveSupplierLink` logika ako
// #239/#121, žiadna nová), adresa u nás (`shop_product_url`, issue 220) a
// dostupnosť u dodávateľa (`supplier_stock`, issue 212/224).
//
// Dostupnosť u dodávateľa sa páruje VÝHRADNE podľa linky extrahovanej z
// `internalNote` (`extractSupplierLink`) — TEN ISTÝ zdroj, aký používa
// scraper (`supplier-stock/run.ts`'s `collectSupplierLinks`) aj
// `restock/queries.ts`. Scraper manažérov OVERRIDE nesleduje vôbec — to je
// EXISTUJÚCE správanie (mimo rozsahu tohto ticketu, zapísané v návrhovom
// komentári na #240), táto obrazovka ho len zobrazuje tak, ako je.
export interface ProductDetailVariant {
  readonly code: string;
  readonly sizeLabel: string | null;
  readonly name: string;
  readonly state: VariantState;
  readonly stock: number;
  readonly price: string | null;
  readonly currency: string | null;
  readonly availabilityText: string;
  readonly productVisibility: string;
  readonly externalCode: string | null;
  readonly missingSince: string | null;
  /** Priama adresa detailu na NAŠOM e-shope (issue 220), `null` = kód nie je vo feede. */
  readonly ourShopUrl: string | null;
  /** `null` = appka o dostupnosti u dodávateľa nemá žiadny záznam. */
  readonly supplierAvailability: "available" | "unavailable" | "unknown" | null;
  readonly supplierAvailabilityText: string | null;
}

export interface ProductDetail {
  readonly productKey: string;
  readonly productName: string;
  readonly supplier: string | null;
  /** Efektívna linka — override MÁ vždy prednosť pred `internalNote` (rovnaká
   * priorita ako `resolveEffectiveSupplierLink` všade inde v appke). */
  readonly supplierLinkUrl: string | null;
  readonly supplierLinkUpdatedAt: string | null;
  readonly supplierLinkSyncedAt: string | null;
  readonly variants: readonly ProductDetailVariant[];
}

export async function getProductDetail(db: Database, productKey: string): Promise<ProductDetail | null> {
  const [product] = await db
    .select({
      key: products.key,
      name: products.name,
      supplier: products.supplier,
      internalNote: products.internalNote,
    })
    .from(products)
    .where(eq(products.key, productKey))
    .limit(1);
  if (product === undefined) return null;

  const [override] = await db
    .select({
      url: productSupplierLinkOverrides.url,
      updatedAt: productSupplierLinkOverrides.updatedAt,
      syncedAt: productSupplierLinkOverrides.syncedAt,
    })
    .from(productSupplierLinkOverrides)
    .where(eq(productSupplierLinkOverrides.productKey, productKey))
    .limit(1);

  const effective = resolveEffectiveSupplierLink(product.internalNote, override?.url ?? null);
  const scrapedLink = extractSupplierLink(product.internalNote).url;

  const variantRows = await db
    .select({
      code: variants.code,
      sizeLabel: variants.sizeLabel,
      name: variants.name,
      state: variants.state,
      stock: variants.stock,
      price: variants.price,
      currency: variants.currency,
      availabilityText: variants.availabilityText,
      productVisibility: variants.productVisibility,
      externalCode: variants.externalCode,
      missingSince: variants.missingSince,
    })
    .from(variants)
    .where(eq(variants.productKey, productKey))
    .orderBy(asc(variants.code));

  const codes = variantRows.map((v) => v.code);
  const shopUrlRows =
    codes.length === 0
      ? []
      : await db
          .select({ code: shopProductUrl.code, url: shopProductUrl.url })
          .from(shopProductUrl)
          .where(inArray(shopProductUrl.code, codes));
  const shopUrlByCode = new Map(shopUrlRows.map((row) => [row.code, row.url]));

  const supplierStockRows =
    scrapedLink === null
      ? []
      : await db
          .select({
            sizeLabel: supplierStock.sizeLabel,
            availability: supplierStock.availability,
            availabilityText: supplierStock.availabilityText,
          })
          .from(supplierStock)
          .where(eq(supplierStock.link, scrapedLink));
  // issue 224: riadok bez rozlíšenia veľkosti nesie `size_label = ''` — použije
  // sa ako záchranná sieť, keď variant NEMÁ vlastný riadok pre svoju veľkosť.
  const supplierStockBySize = new Map(supplierStockRows.map((row) => [row.sizeLabel, row]));
  const supplierStockBlanket = supplierStockBySize.get("") ?? null;

  const variantDetails: ProductDetailVariant[] = variantRows.map((v) => {
    const matched = supplierStockBySize.get((v.sizeLabel ?? "").trim()) ?? supplierStockBlanket;
    return {
      code: v.code,
      sizeLabel: v.sizeLabel,
      name: v.name,
      state: v.state,
      stock: v.stock,
      price: v.price,
      currency: v.currency,
      availabilityText: v.availabilityText,
      productVisibility: v.productVisibility,
      externalCode: v.externalCode,
      missingSince: v.missingSince?.toISOString() ?? null,
      ourShopUrl: shopUrlByCode.get(v.code) ?? null,
      supplierAvailability: matched?.availability ?? null,
      supplierAvailabilityText: matched?.availabilityText ?? null,
    };
  });

  return {
    productKey: product.key,
    productName: product.name,
    supplier: product.supplier,
    supplierLinkUrl: effective.url,
    supplierLinkUpdatedAt: override?.updatedAt.toISOString() ?? null,
    supplierLinkSyncedAt: override?.syncedAt?.toISOString() ?? null,
    variants: variantDetails,
  };
}
