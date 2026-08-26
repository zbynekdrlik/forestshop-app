import { and, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orders } from "../../db/schema.js";
import { listOpenStatusNames } from "./open-statuses.js";

// issue 132 + 492: `createHttpOrderIdsFetcher` AJ `createHttpOrdersExportFetcher`
// (fetcher.ts) dostávajú `dateFrom`/`dateUntil` z `computeImportWindow` —
// posúvajúce sa 90-dňové okno počítané od `now`, takže objednávka staršia než
// 90 dní z exportu UŽ NIKDY nevypadne. To spôsobuje DVE nezávislé straty:
//   - #132: XML export (jediný zdroj `order.shoptet_order_id`) taku objednávku
//     nezachytí — id navždy chýba, aj keď je otvorená.
//   - #492: CSV export (jediná cesta osviežujúca `order.status_name`, #59) ju
//     nezachytí — status zamrzne (napr. objednávka vybavená v Shoptete AŽ PO
//     vypadnutí z okna zostane v appke navždy "Vybavuje sa" a visí v "Na
//     objednanie", napr. 20260739).
// Funkcie nižšie zisťujú, o koľko treba okno predĺžiť dozadu, aby zachytilo
// takú objednávku — samostatne pre XML id-fetch (`computeOrderIdsWindowStart`,
// LEN otvorené BEZ id) a pre CSV import (`computeOrdersExportWindowStart`,
// KAŽDÁ otvorená — presne prípad #492, kde 20260739 svoje id UŽ MÁ, ale status
// je zamrznutý). CSV rozšírenie nechá `previousLineRatio` akceptačnú bránu
// (`ingest.ts`) apples-to-apples: aj `windowStart` (počítadlo DB riadkov) aj
// stiahnutý export sa rozšíria SPOLU, takže pomer sa zachová.

/**
 * Najstarší `placedAt` medzi OTVORENÝMI objednávkami (rovnaká definícia
 * "otvorená" ako "Na objednanie" — `orders.statusName` v `listOpenStatusNames()`)
 * spĺňajúcimi voliteľný `extra` predikát. `null`, keď žiadna taká objednávka
 * neexistuje (nič nechýba, alebo nie je nastavený žiadny otvorený stav —
 * rovnaký guard ako `queries.ts`'s `listOpenOrderLinesBySupplier`, `inArray` s
 * prázdnym poľom by nemalo podľa čoho filtrovať).
 */
async function oldestOpenOrderPlacedAt(
  db: Pick<Database, "select">,
  extra?: SQL,
): Promise<Date | null> {
  const openStatuses = await listOpenStatusNames(db);
  if (openStatuses.length === 0) return null;

  const openFilter = inArray(orders.statusName, [...openStatuses]);
  const [row] = await db
    .select({ oldest: sql<string | null>`min(${orders.placedAt})` })
    .from(orders)
    .where(extra === undefined ? openFilter : and(extra, openFilter));
  // `min()` cez raw `sql` šablónu neprejde drizzle-ovým stĺpcovým mapperom
  // (ten by `timestamp` normálne vrátil ako `Date`) — pg driver ho preto
  // vracia ako ISO reťazec, nie `Date` objekt. Explicitná konverzia tu, nie
  // spoliehanie sa na typový cast vyššie.
  return row?.oldest === null || row?.oldest === undefined ? null : new Date(row.oldest);
}

/**
 * issue 132: najstaršia OTVORENÁ objednávka, ktorej chýba `shoptet_order_id`
 * (podmnožina otvorených). Pre XML id-fetch okno.
 */
export function findOldestOpenOrderMissingShoptetId(db: Pick<Database, "select">): Promise<Date | null> {
  return oldestOpenOrderPlacedAt(db, isNull(orders.shoptetOrderId));
}

/**
 * issue 492: najstaršia OTVORENÁ objednávka BEZ ohľadu na id — každá otvorená
 * objednávka staršia než okno má zamrznutý status_name (CSV import ju
 * neosviežuje). Pre CSV import okno. Nadmnožina `findOldestOpenOrderMissingShoptetId`.
 */
export function findOldestOpenOrder(db: Pick<Database, "select">): Promise<Date | null> {
  return oldestOpenOrderPlacedAt(db);
}

/**
 * Počiatok okna PRE XML id-fetch (`createHttpOrderIdsFetcher`'s `dateFrom`) —
 * nikdy nezúži `defaultDateFrom` (predvolené 90-dňové okno, `computeImportWindow`),
 * len ho voliteľne predĺži dozadu, aby zachytil KAŽDÚ dnes otvorenú objednávku,
 * ktorej id ešte chýba. Sebaozdravujúce: kým je objednávka otvorená A chýba jej
 * id, okno ju zachytáva pri každom behu; len čo id raz zistí, `ingestOrders`'s
 * `COALESCE` zápis ho už navždy chráni a okno sa pre ňu ďalej netýka.
 */
export async function computeOrderIdsWindowStart(
  db: Pick<Database, "select">,
  defaultDateFrom: Date,
): Promise<Date> {
  return extendWindowStartBack(await findOldestOpenOrderMissingShoptetId(db), defaultDateFrom);
}

/**
 * issue 492: počiatok okna PRE CSV import (`createHttpOrdersExportFetcher`'s
 * `dateFrom` A `windowStart` akceptačnej brány) — nikdy nezúži `defaultDateFrom`,
 * len ho voliteľne predĺži dozadu na najstaršiu OTVORENÚ objednávku, aby sa jej
 * `status_name` zosúladil so Shoptetom aj keď vypadla z 90-dňového okna.
 * Sebaozdravujúce: kým je objednávka otvorená, okno ju pri každom behu zachytáva
 * a status osviežuje; keď ju Shoptet vybaví, ďalší import ju osvieži na terminálny
 * stav a vypadne z otvorenej množiny (→ prestane predlžovať okno). Žiadna
 * heuristika "staré = vybavené" — status sa vždy preberá zo Shoptetu.
 */
export async function computeOrdersExportWindowStart(
  db: Pick<Database, "select">,
  defaultDateFrom: Date,
): Promise<Date> {
  return extendWindowStartBack(await findOldestOpenOrder(db), defaultDateFrom);
}

function extendWindowStartBack(oldest: Date | null, defaultDateFrom: Date): Date {
  if (oldest !== null && oldest.getTime() < defaultDateFrom.getTime()) return oldest;
  return defaultDateFrom;
}
