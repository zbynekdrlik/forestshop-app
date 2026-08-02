import { asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderLines, orders, variants } from "../../db/schema.js";
import { listOpenStatusNames } from "../orders/open-statuses.js";
import { isEligibleOrder, type ReminderEligibleOrder } from "./logic.js";

/** Všetky objednávky v NASTAVENOM otvorenom stave (rovnaký zoznam ako "Na
 * objednanie", `listOpenStatusNames`) — BEZ vekového filtra (ten je na
 * `logic.ts`'s `isOldEnough`, aplikovaný samostatne v `run.ts`, rovnaký
 * zámer ako #172's rozdelenie eligible/shipments). Tento zoznam je AJ
 * "oknom", proti ktorému sa `order_reminder_state` čistí — objednávka, čo
 * medzičasom opustí otvorené stavy, stráca svoj záznam pri ďalšom behu. */
export async function loadEligibleOrders(db: Database): Promise<readonly ReminderEligibleOrder[]> {
  const openStatusNames = await listOpenStatusNames(db);
  const openStatuses = new Set(openStatusNames);
  if (openStatuses.size === 0) return [];
  const rows = await db
    .select({
      externalOrderId: orders.externalOrderId,
      placedAt: orders.placedAt,
      statusName: orders.statusName,
      shopRemark: orders.shopRemark,
      email: orders.email,
      phone: orders.phone,
      customerName: orders.customerName,
      shoptetOrderId: orders.shoptetOrderId,
    })
    .from(orders)
    .where(inArray(orders.statusName, [...openStatuses]));
  return rows.filter((row) => isEligibleOrder(row, openStatuses));
}

/** "Položka" stĺpec na obrazovke (ticket) — prvý (abecedne podľa
 * `variantCode`) názov tovaru na objednávke, s "+ N ďalších" pri viacerých
 * riadkoch. Len zobrazovacia pomôcka (rovnaký zdroj ako "Na objednanie"'s
 * `variantName`), NIKDY nevstupuje do eligibility/AI/e-mailovej logiky. */
export async function loadItemLabels(db: Database, externalOrderIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  if (externalOrderIds.length === 0) return out;
  const rows = await db
    .select({
      externalOrderId: orders.externalOrderId,
      variantCode: orderLines.variantCode,
      variantName: variants.name,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .innerJoin(variants, eq(variants.code, orderLines.variantCode))
    .where(inArray(orders.externalOrderId, [...externalOrderIds]))
    .orderBy(asc(orders.externalOrderId), asc(orderLines.variantCode));
  const perOrder = new Map<string, string[]>();
  for (const row of rows) {
    const list = perOrder.get(row.externalOrderId) ?? [];
    list.push(row.variantName);
    perOrder.set(row.externalOrderId, list);
  }
  for (const [code, names] of perOrder) {
    const [first, ...rest] = names;
    if (first === undefined) continue;
    out.set(code, rest.length > 0 ? `${first} (+ ${String(rest.length)} ďalších)` : first);
  }
  return out;
}
