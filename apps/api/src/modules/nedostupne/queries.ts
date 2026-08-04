import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderLines, orders, products, productSupplierLinkOverrides, shopProductUrl, variants } from "../../db/schema.js";
import { resolveEffectiveSupplierLink } from "../orders/effective-supplier-link.js";
import { buildShoptetAdminOrderUrl } from "../orders/queries.js";
import { listOpenStatusNames } from "../orders/open-statuses.js";
import { listReplacementLinksByVariant, type ReplacementLink } from "./replacement-links.js";
import { loadSentNedostupne, sentKey } from "./state.js";

export interface NedostupneOrderRow {
  readonly orderCode: string;
  readonly adminLink: string;
  readonly customerName: string;
  readonly email: string;
  readonly quantity: number;
  readonly placedAt: string;
  readonly nedostupneSent: boolean;
  readonly alternativaSent: boolean;
}

export interface NedostupneGroup {
  readonly variantCode: string;
  readonly itemName: string;
  readonly sizeLabel: string | null;
  // issue 238: preklik na náš e-shop — `null` = adresu vo feede pre
  // porovnávače nemáme, meno ZOSTÁVA NEAKTÍVNE (žiadny vyhľadávací
  // fallback, na rozdiel od `shopLinks.ts`'s `ourProductLink` — ticket to
  // žiada explicitne: "nikdy nevyrábať adresu odhadom").
  readonly ourProductUrl: string | null;
  // issue 238: preklik na dodávateľa (rovnaká funkcia ako "Na objednanie",
  // `resolveEffectiveSupplierLink`) — `null` = appka žiadny odkaz nemá.
  readonly supplierUrl: string | null;
  // issue 238: majiteľove RUČNE vložené odkazy náhrad — nahrádza pôvodný
  // automatický zoznam z `product.relatedCodes`.
  readonly replacementLinks: readonly ReplacementLink[];
  readonly orders: readonly NedostupneOrderRow[];
}

/**
 * "Nedostupné tovary" — zoznam zoskupený PODĽA VARIANTU (rovnaká granularita
 * ako `order_line.variant_code`), spárovaný s otvorenými objednávkami
 * (`listOpenStatusNames`, ten istý set ako "Na objednanie"/pripomienky).
 * ŽIADNY `job_run` cache — zoznam sa počíta VŽDY živo (návrhový komentár na
 * issue 176: táto automatizácia nemá žiadny naplánovaný beh).
 */
export async function listNedostupneGroups(db: Database, adminBaseUrl: string): Promise<readonly NedostupneGroup[]> {
  const openStatuses = await listOpenStatusNames(db);
  if (openStatuses.length === 0) return [];

  const rows = await db
    .select({
      variantCode: orderLines.variantCode,
      quantity: orderLines.quantity,
      itemName: variants.name,
      sizeLabel: variants.sizeLabel,
      internalNote: products.internalNote,
      supplierLinkOverride: productSupplierLinkOverrides.url,
      ourProductUrl: shopProductUrl.url,
      orderCode: orders.externalOrderId,
      customerName: orders.customerName,
      email: orders.email,
      shoptetOrderId: orders.shoptetOrderId,
      placedAt: orders.placedAt,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orderLines.orderId, orders.id))
    .innerJoin(variants, eq(orderLines.variantCode, variants.code))
    .innerJoin(products, eq(variants.productKey, products.key))
    .leftJoin(productSupplierLinkOverrides, eq(productSupplierLinkOverrides.productKey, products.key))
    .leftJoin(shopProductUrl, eq(shopProductUrl.code, orderLines.variantCode))
    .where(and(eq(orderLines.state, "nedostupne"), inArray(orders.statusName, [...openStatuses])))
    .orderBy(desc(orders.placedAt));

  if (rows.length === 0) return [];

  const sent = await loadSentNedostupne(db);
  const replacementLinksByVariant = await listReplacementLinksByVariant(db, [...new Set(rows.map((r) => r.variantCode))]);

  const groups = new Map<
    string,
    { itemName: string; sizeLabel: string | null; ourProductUrl: string | null; supplierUrl: string | null; orders: NedostupneOrderRow[] }
  >();
  for (const row of rows) {
    let group = groups.get(row.variantCode);
    if (group === undefined) {
      group = {
        itemName: row.itemName,
        sizeLabel: row.sizeLabel,
        ourProductUrl: row.ourProductUrl,
        supplierUrl: resolveEffectiveSupplierLink(row.internalNote, row.supplierLinkOverride).url,
        orders: [],
      };
      groups.set(row.variantCode, group);
    }
    group.orders.push({
      orderCode: row.orderCode,
      adminLink: buildShoptetAdminOrderUrl(adminBaseUrl, row.orderCode, row.shoptetOrderId),
      customerName: row.customerName,
      email: row.email ?? "",
      quantity: row.quantity,
      placedAt: row.placedAt.toISOString(),
      nedostupneSent: sent.has(sentKey(row.orderCode, row.variantCode, "nedostupne")),
      alternativaSent: sent.has(sentKey(row.orderCode, row.variantCode, "alternativa")),
    });
  }

  // Zoradenie: variant, ktorého NAJNOVŠIA otvorená objednávka je najčerstvejšia,
  // navrchu — rovnaký zámer ako stará appka's "MAX open-order date descending"
  // (zákazník s najčerstvejšou objednávkou hore, nie ten, čo čaká najdlhšie).
  const maxPlacedAt = (orders: readonly NedostupneOrderRow[]): string => orders.reduce((max, o) => (o.placedAt > max ? o.placedAt : max), "");

  return [...groups.entries()]
    .map(([variantCode, g]) => ({
      variantCode,
      itemName: g.itemName,
      sizeLabel: g.sizeLabel,
      ourProductUrl: g.ourProductUrl,
      supplierUrl: g.supplierUrl,
      replacementLinks: replacementLinksByVariant.get(variantCode) ?? [],
      orders: g.orders,
    }))
    .sort((a, b) => {
      const d = maxPlacedAt(b.orders).localeCompare(maxPlacedAt(a.orders));
      if (d !== 0) return d;
      return a.itemName.localeCompare(b.itemName) || a.variantCode.localeCompare(b.variantCode);
    });
}
