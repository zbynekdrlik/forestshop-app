import { and, count, desc, eq, inArray, isNull, ne, or, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { dpdShipments, orders } from "../../db/schema.js";
import { listOpenStatusNames } from "../orders/open-statuses.js";
import { buildDpdShipmentPreview, type DpdOrderSource, type DpdShipmentPreview } from "./preview.js";

// issue 292: "pripravené na odoslanie" = objednávka BEZ appka-vlastného
// úspešného `dpd_shipment` záznamu (appka teda ešte túto objednávku cez DPD
// neodoslala) A BEZ Shoptet-ovho vlastného `package_number` (obchod ju
// mohol odoslať aj mimo tejto appky).
//
// issue 445: PLUS len OTVORENÉ objednávky — `order.status_name` je v
// OTVORENOM stave (`order_open_status`, default "Vybavuje sa"). Šéf videl
// priveľa objednávok s možnosťou objednať DPD, lebo pôvodný filter stav
// vôbec neriešil, takže aj stornované/vybavené objednávky bez
// `package_number` kvalifikovali. Znovupoužívame TEN ISTÝ admin-
// konfigurovateľný `order_open_status` mechanizmus ako "Na objednanie"
// (žiadny nový hardcoded zoznam terminálnych stavov v tomto module) — z
// konštrukcie tak nikdy neponúkne terminálne stavy ("Stornovaná"/
// "Vybavená"/"Vratený tovar"/"Vybavená výmena"/"Vybavený Dobropis"), ktoré
// v open sete nie sú. Obsluha si spomedzi otvorených sama vyberie, ktoré
// reálne zabalené objednávky odošle (`.claude/rules/dpd.md`).
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

// issue 445: JEDNA zdieľaná WHERE podmienka pre zoznam AJ počet, aby sa
// nemohli rozísť (badge počet = dĺžka zoznamu). `openStatuses` sa dodá
// zvonka (načítané raz cez `listOpenStatusNames`), rovnaký idiom
// `inArray(orders.statusName, [...openStatuses])` ako `orders/queries.ts`/
// `nedostupne`/`order-reminder`/`backfill`/`merge-mail`.
function shippableWhere(openStatuses: readonly string[]): SQL | undefined {
  return and(
    isNull(orders.packageNumber),
    or(isNull(dpdShipments.status), ne(dpdShipments.status, "submitted")),
    inArray(orders.statusName, [...openStatuses]),
  );
}

export async function listDpdShippableOrders(db: Database): Promise<readonly DpdShippableOrder[]> {
  const openStatuses = await listOpenStatusNames(db);
  const rows = await db
    .select({ ...SELECT_COLUMNS, shipmentStatus: dpdShipments.status, shipmentError: dpdShipments.errorMessage })
    .from(orders)
    .leftJoin(dpdShipments, eq(dpdShipments.orderId, orders.id))
    .where(shippableWhere(openStatuses))
    .orderBy(desc(orders.placedAt));

  return rows.map((row) => ({
    placedAt: row.placedAt,
    preview: buildDpdShipmentPreview(toOrderSource(row)),
    lastFailure: row.shipmentStatus === "failed" ? row.shipmentError : null,
  }));
}

// issue 445: lacný COUNT pre nav badge ("dneska treba objednať N DPD
// preprav") — TÁ ISTÁ `shippableWhere` podmienka ako zoznam vyššie, takže
// číslo v menu vždy sedí s dĺžkou zobrazeného zoznamu.
export async function countDpdShippableOrders(db: Database): Promise<number> {
  const openStatuses = await listOpenStatusNames(db);
  const [row] = await db
    .select({ total: count() })
    .from(orders)
    .leftJoin(dpdShipments, eq(dpdShipments.orderId, orders.id))
    .where(shippableWhere(openStatuses));
  return row?.total ?? 0;
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
