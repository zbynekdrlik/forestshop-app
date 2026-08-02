import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderLines, orders, products, variants } from "../../db/schema.js";
import { buildShoptetAdminOrderUrl } from "../orders/queries.js";
import { listOpenStatusNames } from "../orders/open-statuses.js";
import { buildAlternatives, type EmailAlternative } from "./logic.js";
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
  readonly alternatives: readonly EmailAlternative[];
  readonly orders: readonly NedostupneOrderRow[];
}

/** Meno pre KAŽDÝ RAW náhradný kód (`product.related_codes`) — hľadá sa
 * PODĽA `variant.code` AJ `variant.pairCode` (relatedProduct hodnota môže
 * byť jedno alebo druhé, rovnaký zámer ako stará appka's
 * `_ensure_nedostupne_catalog`). Neznáme kódy jednoducho chýbajú z mapy —
 * `buildAlternatives` (`logic.ts`) padá vtedy späť na kód samotný. */
export async function resolveAlternativeNames(db: Pick<Database, "select">, codes: readonly string[]): Promise<ReadonlyMap<string, string>> {
  if (codes.length === 0) return new Map();
  const wanted = new Set(codes);
  const rows = await db
    .select({ code: variants.code, pairCode: variants.pairCode, name: variants.name })
    .from(variants)
    .where(or(inArray(variants.code, [...codes]), inArray(variants.pairCode, [...codes])));
  const map = new Map<string, string>();
  for (const row of rows) {
    if (wanted.has(row.code)) map.set(row.code, row.name);
    if (row.pairCode !== null && wanted.has(row.pairCode) && !map.has(row.pairCode)) map.set(row.pairCode, row.name);
  }
  return map;
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
      relatedCodes: products.relatedCodes,
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
    .where(and(eq(orderLines.state, "nedostupne"), inArray(orders.statusName, [...openStatuses])))
    .orderBy(desc(orders.placedAt));

  if (rows.length === 0) return [];

  const sent = await loadSentNedostupne(db);
  const allCodes = [...new Set(rows.flatMap((r) => r.relatedCodes ?? []))];
  const names = await resolveAlternativeNames(db, allCodes);

  const groups = new Map<
    string,
    { itemName: string; sizeLabel: string | null; relatedCodes: readonly string[]; orders: NedostupneOrderRow[] }
  >();
  for (const row of rows) {
    let group = groups.get(row.variantCode);
    if (group === undefined) {
      group = { itemName: row.itemName, sizeLabel: row.sizeLabel, relatedCodes: row.relatedCodes ?? [], orders: [] };
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

  // Zoradenie: variant s najnovšou otvorenou objednávkou navrchu (zákazník,
  // ktorý čaká najdlhšie... nie, presne opačne — najnovší je pridaný k
  // dopytu ako PRVÝ vďaka `orderBy(desc(placedAt))`, takže skupina, ktorej
  // PRVÝ (najnovší) riadok appka vidí najskôr, sa aj zoradí navrchu — rovnaký
  // zámer ako stará appka's "MAX open-order date descending".
  const maxDate = (g: { orders: NedostupneOrderRow[] }): string => g.orders.reduce((max, o) => (o.placedAt > max ? o.placedAt : max), "");

  return [...groups.entries()]
    .map(([variantCode, g]) => ({
      variantCode,
      itemName: g.itemName,
      sizeLabel: g.sizeLabel,
      alternatives: buildAlternatives(g.relatedCodes, names),
      orders: g.orders,
    }))
    .sort((a, b) => {
      const d = maxDate({ orders: [...b.orders] }).localeCompare(maxDate({ orders: [...a.orders] }));
      if (d !== 0) return d;
      return a.itemName.localeCompare(b.itemName) || a.variantCode.localeCompare(b.variantCode);
    });
}
