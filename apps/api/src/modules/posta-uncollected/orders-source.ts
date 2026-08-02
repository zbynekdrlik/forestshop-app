import { gte } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orders } from "../../db/schema.js";
import { isEligibleOrder, type EligibleOrder } from "./logic.js";

// O pár dní širšie než 30-dňové okno, aby SQL filter nikdy neorezal riadok,
// ktorý `isEligibleOrder` (presná hranica, počítaná od `today`) ešte považuje
// za eligible — JS strana je AUTORITA nad presnou hranicou, toto je len
// hrubší, lacnejší predfilter na úrovni dopytu.
const SQL_PREFILTER_MARGIN_DAYS = 35;

/** Všetky objednávky, za ktoré je táto automatizácia zodpovedná (30-dňové
 * okno, nie stornované, nie iný dopravca než pošta) — BEZ filtra na
 * vyplnené číslo zásielky (to si `run.ts` robí samostatne, presne ako stará
 * appka: `_eligible_orders` vs. `shipments_from_orders_csv`). */
export async function loadEligibleOrders(db: Database, today: Date): Promise<readonly EligibleOrder[]> {
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() - SQL_PREFILTER_MARGIN_DAYS);
  const rows = await db
    .select({
      externalOrderId: orders.externalOrderId,
      placedAt: orders.placedAt,
      statusName: orders.statusName,
      shippingCarrierName: orders.shippingCarrierName,
      packageNumber: orders.packageNumber,
      email: orders.email,
      phone: orders.phone,
      customerName: orders.customerName,
      shoptetOrderId: orders.shoptetOrderId,
    })
    .from(orders)
    .where(gte(orders.placedAt, cutoff));
  return rows.filter((row) => isEligibleOrder(row, today));
}
