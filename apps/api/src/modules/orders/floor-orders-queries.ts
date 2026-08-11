import { desc, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orders } from "../../db/schema.js";
import { buildShoptetAdminOrderUrl } from "./queries.js";

// issue 345: "Eshop → Objednávky predajňa" — READ-ONLY zoznam objednávok,
// ktoré nevznikli v e-shope, ale na kamennej predajni. Priznak je overený
// NAŽIVO na produkcii (ticket, komentár 11.8.2026 + STEP 0 re-overenie
// pred implementáciou): `shipping_carrier_name` obsahuje podreťazec
// "Osobný odber" (`Osobný odber - len na predajni v POPRADE!`, 30→32
// objednávok). ILIKE na PODREŤAZEC (nikdy presnú vetu s výkričníkom) —
// prežije zmenu textu v Shoptete, rozhodnuté na tickete.
//
// Na rozdiel od `order-flags-queries.ts` (načíta VŠETKO a filtruje/
// stránkuje v JS, lebo potrebuje per-riadkový odvodený `unresolved` stav)
// je toto čistý jednotabuľkový WHERE+ORDER BY bez per-riadkového odvodenia
// — skutočné SQL `LIMIT`/`OFFSET` + `COUNT(*)` je tu správnejšie, presne
// vzor `catalog/queries.ts`'s `searchVariants`/`restock-links-routes.ts`.
// Ticket výslovne žiada zdieľaný `useLoadMore` hook (#337) — ten doteraz
// vždy sedel na skutočnom `page`/`pageSize`/`total` kontrakte, nikdy na
// load-everything vzore.
const FLOOR_ORDER_SHIPPING_PATTERN = "%Osobný odber%";

export interface FloorOrderRow {
  readonly id: string;
  readonly externalOrderId: string;
  readonly customerName: string;
  readonly statusName: string;
  readonly placedAt: string;
  readonly totalPriceWithVat: string | null;
  readonly adminUrl: string;
}

export interface FloorOrdersSearchInput {
  readonly page: number;
  readonly pageSize: number;
}

export interface FloorOrdersSearchResult {
  readonly total: number;
  readonly items: readonly FloorOrderRow[];
}

export async function listFloorOrders(
  db: Database,
  adminBaseUrl: string,
  input: FloorOrdersSearchInput,
): Promise<FloorOrdersSearchResult> {
  const where = sql`${orders.shippingCarrierName} ILIKE ${FLOOR_ORDER_SHIPPING_PATTERN}`;

  const [totals] = await db
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(orders)
    .where(where);

  const rows = await db
    .select({
      id: orders.id,
      externalOrderId: orders.externalOrderId,
      customerName: orders.customerName,
      statusName: orders.statusName,
      placedAt: orders.placedAt,
      totalPriceWithVat: orders.totalPriceWithVat,
      shoptetOrderId: orders.shoptetOrderId,
    })
    .from(orders)
    .where(where)
    // Najnovšie hore — zadanie tiketu.
    .orderBy(desc(orders.placedAt))
    .limit(input.pageSize)
    .offset((input.page - 1) * input.pageSize);

  const items: FloorOrderRow[] = rows.map((row) => ({
    id: row.id,
    externalOrderId: row.externalOrderId,
    customerName: row.customerName,
    statusName: row.statusName,
    placedAt: row.placedAt.toISOString(),
    totalPriceWithVat: row.totalPriceWithVat,
    adminUrl: buildShoptetAdminOrderUrl(adminBaseUrl, row.externalOrderId, row.shoptetOrderId),
  }));

  return { total: totals?.total ?? 0, items };
}
