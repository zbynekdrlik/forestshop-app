import { eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { productSupplierLinkOverrides, products, variants } from "../../db/schema.js";
import { resolveEffectiveSupplierLink } from "../orders/effective-supplier-link.js";

// issue 239: "Eshop → Párovanie produktov" — zoznam PRODUKTOV (nie variantov,
// na rozdiel od `pairing/queries.ts`'s `listPairings`), ktoré NEMAJÚ efektívnu
// dodávateľskú linku, s možnosťou ju doplniť/opraviť. Kľúčované `product.key`,
// rovnaké kľúčovanie ako `product_supplier_link_override` (issue 121/122) —
// zámerne INÝ dátový model než skrytá `pairing` záložka (variant-kľúčovaný
// stavový automat pre budúce #46/#48, viď návrhový komentár na ticket).
export type ProductLinkState = "all" | "missing" | "linked";

export interface ProductLinkItem {
  readonly productKey: string;
  readonly productName: string;
  readonly supplier: string | null;
  readonly variantCount: number;
  /** Efektívna linka (`resolveEffectiveSupplierLink` — override MÁ vždy prednosť
   * pred extrahovaným `internalNote` odkazom), `null` = appka žiadnu nepozná. */
  readonly url: string | null;
  readonly updatedAt: string | null;
  /** `null` = ešte nikdy odoslané do Shoptetu (`shoptet-writeback` job, #122). */
  readonly syncedAt: string | null;
}

export interface ProductLinkSearchInput {
  readonly q: string;
  readonly state: ProductLinkState;
  readonly page: number;
  readonly pageSize: number;
}

export interface ProductLinkSearchResult {
  readonly total: number;
  /** Koľko produktov CELKOVO (nezávisle od `q`/`state` filtra vyššie) nemá
   * efektívnu linku — ticketova akceptačná podmienka "nech je vidno, koľko
   * ich celkovo zostáva". */
  readonly missingTotal: number;
  readonly items: readonly ProductLinkItem[];
}

// Efektívna linka sa vyhodnocuje AŽ v JS (`resolveEffectiveSupplierLink` je
// čistá regexová funkcia nad `internalNote`, nedá sa vyjadriť ako SQL
// predikát bez duplicity logiky) — rovnaký vzor ako `supplier-stock/run.ts`'s
// `collectSupplierLinks`. Celý katalóg (rádovo tisícky produktov) sa preto
// načíta a filtruje v pamäti — prijateľné pre riadkovú manažérsku obrazovku
// (MVP filozofia), nie hot-path.
export async function listProductLinks(db: Database, input: ProductLinkSearchInput): Promise<ProductLinkSearchResult> {
  const productRows = await db
    .select({
      productKey: products.key,
      productName: products.name,
      supplier: products.supplier,
      internalNote: products.internalNote,
      overrideUrl: productSupplierLinkOverrides.url,
      updatedAt: productSupplierLinkOverrides.updatedAt,
      syncedAt: productSupplierLinkOverrides.syncedAt,
    })
    .from(products)
    .leftJoin(productSupplierLinkOverrides, eq(productSupplierLinkOverrides.productKey, products.key));

  const countRows = await db
    .select({ productKey: variants.productKey, count: sql<number>`count(*)`.mapWith(Number) })
    .from(variants)
    .groupBy(variants.productKey);
  const variantCountByProduct = new Map(countRows.map((row) => [row.productKey, row.count]));

  const allItems: ProductLinkItem[] = productRows.map((row) => {
    const effective = resolveEffectiveSupplierLink(row.internalNote, row.overrideUrl);
    return {
      productKey: row.productKey,
      productName: row.productName,
      supplier: row.supplier,
      variantCount: variantCountByProduct.get(row.productKey) ?? 0,
      url: effective.url,
      updatedAt: row.updatedAt?.toISOString() ?? null,
      syncedAt: row.syncedAt?.toISOString() ?? null,
    };
  });

  const missingTotal = allItems.filter((item) => item.url === null).length;

  const q = input.q.trim().toLowerCase();
  const filtered = allItems.filter((item) => {
    if (input.state === "missing" && item.url !== null) return false;
    if (input.state === "linked" && item.url === null) return false;
    if (q === "") return true;
    return item.productKey.toLowerCase().includes(q) || item.productName.toLowerCase().includes(q);
  });

  filtered.sort((a, b) => a.productName.localeCompare(b.productName, "sk"));

  const total = filtered.length;
  const start = (input.page - 1) * input.pageSize;
  const items = filtered.slice(start, start + input.pageSize);

  return { total, missingTotal, items };
}
