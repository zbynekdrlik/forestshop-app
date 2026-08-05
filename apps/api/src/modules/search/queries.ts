import { asc, desc, eq, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orders, products, variants } from "../../db/schema.js";
import { escapeLikePattern } from "../catalog/queries.js";
import type { VariantState } from "../catalog/availability.js";
import { buildShoptetAdminOrderUrl } from "../orders/queries.js";

// issue 240: "Eshop → Vyhľadať" — JEDNO pole, ktoré hľadá naprieč appkou, ale
// výsledky radí PREDNOSTNE produkty (ticketova požiadavka). Namiesto umelej
// "relevance" logiky nad jedným zoradeným zoznamom appka vracia DVE oddelené
// polia (`products`/`orders`) — front-end ich vykreslí ako dva viditeľne
// oddelené bloky, produkty prirodzene PRED objednávkami, bez potreby
// počítať skóre.
//
// Rozsah "hľadať všetko" (zapísané aj na ticket pri návrhu): prehľadáva sa
// VÝHRADNE katalóg (kód variantu/názov/dodávateľ/kód u dodávateľa) a
// objednávky (číslo objednávky/meno zákazníka/e-mail) — texty e-mailov,
// kniha odoslaných e-mailov, história plánovača, nastavenia automatizácií,
// surové riadky dodávateľského skladu, audit log a používatelia sa VEDOME
// neprehľadávajú (nie sú to "tovar" ani "objednávka", ktoré ticket opisuje).
export interface ProductSearchHit {
  readonly productKey: string;
  readonly variantCode: string;
  readonly productName: string;
  readonly sizeLabel: string | null;
  readonly supplier: string | null;
  readonly externalCode: string | null;
  readonly state: VariantState;
}

export interface OrderSearchHit {
  readonly orderId: string;
  readonly externalOrderId: string;
  readonly customerName: string;
  readonly email: string | null;
  readonly statusName: string;
  readonly placedAt: string;
  readonly adminUrl: string;
}

export interface GlobalSearchResult {
  readonly products: readonly ProductSearchHit[];
  readonly orders: readonly OrderSearchHit[];
}

// MVP horné stropy — táto obrazovka je "rýchla ruka" na jeden konkrétny kus
// tovaru/objednávku (majiteľov vlastný opis, ticket), nie stránkovaný
// zoznam ako katalóg/Na objednanie. Málo, presných výsledkov je tu cieľom,
// nie úplnosť.
const PRODUCT_LIMIT = 20;
const ORDER_LIMIT = 10;

export async function globalSearch(db: Database, q: string, adminBaseUrl: string): Promise<GlobalSearchResult> {
  const trimmed = q.trim();
  if (trimmed === "") return { products: [], orders: [] };
  const pattern = `%${escapeLikePattern(trimmed)}%`;

  const productRows = await db
    .select({
      productKey: variants.productKey,
      variantCode: variants.code,
      productName: variants.name,
      sizeLabel: variants.sizeLabel,
      supplier: products.supplier,
      externalCode: variants.externalCode,
      state: variants.state,
    })
    .from(variants)
    .innerJoin(products, eq(products.key, variants.productKey))
    .where(
      or(
        sql`${variants.code} ILIKE ${pattern}`,
        sql`${variants.name} ILIKE ${pattern}`,
        sql`${products.supplier} ILIKE ${pattern}`,
        sql`${variants.externalCode} ILIKE ${pattern}`,
      ),
    )
    .orderBy(asc(variants.name), asc(variants.code))
    .limit(PRODUCT_LIMIT);

  const orderRows = await db
    .select({
      orderId: orders.id,
      externalOrderId: orders.externalOrderId,
      customerName: orders.customerName,
      email: orders.email,
      statusName: orders.statusName,
      placedAt: orders.placedAt,
      shoptetOrderId: orders.shoptetOrderId,
    })
    .from(orders)
    .where(
      or(
        sql`${orders.externalOrderId} ILIKE ${pattern}`,
        sql`${orders.customerName} ILIKE ${pattern}`,
        sql`${orders.email} ILIKE ${pattern}`,
      ),
    )
    .orderBy(desc(orders.placedAt))
    .limit(ORDER_LIMIT);

  return {
    products: productRows,
    orders: orderRows.map((row) => ({
      orderId: row.orderId,
      externalOrderId: row.externalOrderId,
      customerName: row.customerName,
      email: row.email,
      statusName: row.statusName,
      placedAt: row.placedAt.toISOString(),
      adminUrl: buildShoptetAdminOrderUrl(adminBaseUrl, row.externalOrderId, row.shoptetOrderId),
    })),
  };
}
