import { and, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orders } from "../../db/schema.js";
import { listOpenStatusNames } from "./open-statuses.js";

// issue 132: `createHttpOrderIdsFetcher` (fetcher.ts) dostáva PEVNÉ
// `dateFrom`/`dateUntil` z `computeImportWindow` — presne to isté posúvajúce
// sa 90-dňové okno, aké používa aj hlavný CSV import. Keďže sa okno vždy
// počíta od `now`, objednávka staršia než 90 dní sa do XML exportu (jediný
// zdroj `order.shoptet_order_id`, issue 120) UŽ NIKDY nedostane — aj keď je
// stále otvorená ("Na objednanie") a aj keď Shoptet jej id má. Funkcie nižšie
// zisťujú, či taká objednávka existuje, a o koľko treba okno IBA pre XML
// id-fetch (nikdy pre hlavný CSV import — ten má vlastnú, nezávislú
// akceptančnú logiku voči `previousLineRatio`, `.claude/rules/orders.md`,
// ktorú netreba meniť) predĺžiť dozadu, aby ju zachytil.

/**
 * Najstarší `placedAt` medzi OTVORENÝMI objednávkami (rovnaká definícia
 * "otvorená" ako "Na objednanie" — `orders.statusName` v
 * `listOpenStatusNames()`), ktorým chýba `shoptet_order_id`. `null`, keď
 * žiadna taká objednávka neexistuje (nič nechýba, alebo nie je nastavený
 * žiadny otvorený stav — rovnaký guard ako `queries.ts`'s
 * `listOpenOrderLinesBySupplier`, `inArray` s prázdnym poľom by nemalo podľa
 * čoho filtrovať).
 */
export async function findOldestOpenOrderMissingShoptetId(
  db: Pick<Database, "select">,
): Promise<Date | null> {
  const openStatuses = await listOpenStatusNames(db);
  if (openStatuses.length === 0) return null;

  const [row] = await db
    .select({ oldest: sql<string | null>`min(${orders.placedAt})` })
    .from(orders)
    .where(and(isNull(orders.shoptetOrderId), inArray(orders.statusName, [...openStatuses])));
  // `min()` cez raw `sql` šablónu neprejde drizzle-ovým stĺpcovým mapperom
  // (ten by `timestamp` normálne vrátil ako `Date`) — pg driver ho preto
  // vracia ako ISO reťazec, nie `Date` objekt. Explicitná konverzia tu, nie
  // spoliehanie sa na typový cast vyššie.
  return row?.oldest === null || row?.oldest === undefined ? null : new Date(row.oldest);
}

/**
 * Počiatok okna PRE XML id-fetch (`createHttpOrderIdsFetcher`'s
 * `dateFrom`) — nikdy nezúži `defaultDateFrom` (predvolené 90-dňové okno,
 * `computeImportWindow`), len ho voliteľne predĺži dozadu, aby zachytil
 * KAŽDÚ dnes otvorenú objednávku, ktorej id ešte chýba. Sebaozdravujúce:
 * kým je objednávka otvorená A chýba jej id, okno ju zachytáva pri každom
 * behu; len čo id raz zistí, `ingestOrders`'s `COALESCE` zápis ho už
 * navždy chráni a okno sa pre ňu ďalej netýka.
 */
export async function computeOrderIdsWindowStart(
  db: Pick<Database, "select">,
  defaultDateFrom: Date,
): Promise<Date> {
  const oldestMissing = await findOldestOpenOrderMissingShoptetId(db);
  if (oldestMissing !== null && oldestMissing.getTime() < defaultDateFrom.getTime()) return oldestMissing;
  return defaultDateFrom;
}
