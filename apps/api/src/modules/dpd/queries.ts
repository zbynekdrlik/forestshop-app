import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { dpdShipments, orders } from "../../db/schema.js";
import { buildDpdShipmentPreview, type DpdOrderSource, type DpdShipmentPreview } from "./preview.js";

// issue 292: "pripravené na odoslanie" = objednávka BEZ appka-vlastného
// úspešného `dpd_shipment` záznamu (appka teda ešte túto objednávku cez DPD
// neodoslala) A BEZ Shoptet-ovho vlastného `package_number` (obchod ju
// mohol odoslať aj mimo tejto appky). Appka zámerne NEFILTRUJE podľa
// Shoptet `status_name` — nemá spoľahlivý zoznam stavov "zabalené, čaká na
// kuriéra" (na rozdiel od "Na objednanie"'s `order_open_status`, ktorý rieši
// INÝ problém — dodávateľské objednávanie, nie expedíciu). Obsluha si sama
// vyberie, ktoré reálne zabalené objednávky odošle (`.claude/rules/dpd.md`).
const SELECT_COLUMNS = {
  id: orders.id,
  externalOrderId: orders.externalOrderId,
  customerName: orders.customerName,
  placedAt: orders.placedAt,
  phone: orders.phone,
  deliveryFullName: orders.deliveryFullName,
  deliveryCompany: orders.deliveryCompany,
  deliveryStreet: orders.deliveryStreet,
  deliveryHouseNumber: orders.deliveryHouseNumber,
  deliveryCity: orders.deliveryCity,
  deliveryZip: orders.deliveryZip,
  deliveryCountryName: orders.deliveryCountryName,
  weight: orders.weight,
  paymentMethodName: orders.paymentMethodName,
  priceToPay: orders.priceToPay,
  totalPriceWithVat: orders.totalPriceWithVat,
} as const;

function toOrderSource(row: {
  readonly id: string;
  readonly externalOrderId: string;
  readonly customerName: string;
  readonly phone: string | null;
  readonly deliveryFullName: string | null;
  readonly deliveryCompany: string | null;
  readonly deliveryStreet: string | null;
  readonly deliveryHouseNumber: string | null;
  readonly deliveryCity: string | null;
  readonly deliveryZip: string | null;
  readonly deliveryCountryName: string | null;
  readonly weight: string | null;
  readonly paymentMethodName: string | null;
  readonly priceToPay: string | null;
  readonly totalPriceWithVat: string | null;
}): DpdOrderSource {
  return row;
}

export interface DpdShippableOrder {
  readonly placedAt: Date;
  readonly preview: DpdShipmentPreview;
  // Predošlý pokus odoslať TÚTO objednávku zlyhal — appka ju ukáže naďalej v
  // zozname (obsluha ju vie skúsiť odoslať znova), s dôvodom posledného
  // zlyhania. `null` = ešte sa vôbec neskúšalo.
  readonly lastFailure: string | null;
}

export async function listDpdShippableOrders(db: Database): Promise<readonly DpdShippableOrder[]> {
  const rows = await db
    .select({ ...SELECT_COLUMNS, shipmentStatus: dpdShipments.status, shipmentError: dpdShipments.errorMessage })
    .from(orders)
    .leftJoin(dpdShipments, eq(dpdShipments.orderId, orders.id))
    .where(and(isNull(orders.packageNumber), or(isNull(dpdShipments.status), ne(dpdShipments.status, "submitted"))))
    .orderBy(desc(orders.placedAt));

  return rows.map((row) => ({
    placedAt: row.placedAt,
    preview: buildDpdShipmentPreview(toOrderSource(row)),
    lastFailure: row.shipmentStatus === "failed" ? row.shipmentError : null,
  }));
}

/** Náhľad pre PRESNE zvolenú množinu objednávok (potvrdzovací krok pred
 * odoslaním) — appka číta rovnaké stĺpce ako zoznam vyššie, len filtrované
 * podľa konkrétnych `orderId`. `weightOverrides` = obsluhou upravená
 * hmotnosť (kľúč `orderId`), keď v náhľade prepísala predvolenú/uloženú
 * hodnotu. */
export async function getDpdShipmentPreviews(
  db: Database,
  orderIds: readonly string[],
  weightOverrides: ReadonlyMap<string, string> = new Map(),
): Promise<readonly DpdShipmentPreview[]> {
  if (orderIds.length === 0) return [];
  const rows = await db.select(SELECT_COLUMNS).from(orders).where(inArray(orders.id, [...orderIds]));
  return rows.map((row) => buildDpdShipmentPreview(toOrderSource(row), weightOverrides.get(row.id)));
}
