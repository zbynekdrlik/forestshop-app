import { and, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orders } from "../../db/schema.js";
import { log } from "../../logger.js";
import { computeImportWindow } from "./fetcher.js";
import { DEFAULT_ORDERS_IMPORT_WINDOW_DAYS } from "./ingest.js";
import { listOpenStatusNames } from "./open-statuses.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
  const oldest = await findOldestOpenOrder(db);
  const start = extendWindowStartBack(oldest, defaultDateFrom);
  // comprehensive-logging: keď sa okno reálne rozšíri, zaznač PREČO a O KOĽKO —
  // pri diagnostike "prečo import ťahá 200 dní" je kľúčové vidieť, KTORÁ otvorená
  // objednávka okno drží (napr. objednávka zmazaná v Shoptete, ktorá by ho držala
  // predĺžené donekonečna). Nad 365 dní je to takmer isto taký prípad → warn.
  if (oldest !== null && start.getTime() < defaultDateFrom.getTime()) {
    const extraDays = Math.round((defaultDateFrom.getTime() - start.getTime()) / MS_PER_DAY);
    const detail = {
      oldestOpenPlacedAt: oldest.toISOString(),
      defaultDateFrom: defaultDateFrom.toISOString(),
      extraDays,
    };
    if (extraDays > 365) {
      log.warn(detail, "okno CSV importu predĺžené o viac než 365 dní — možno objednávka otvorená v appke, ktorá už v Shoptete neexistuje");
    } else {
      log.info(detail, "okno CSV importu predĺžené dozadu, aby zachytilo staršiu otvorenú objednávku (osvieženie stavu, #492)");
    }
  }
  return start;
}

function extendWindowStartBack(oldest: Date | null, defaultDateFrom: Date): Date {
  if (oldest !== null && oldest.getTime() < defaultDateFrom.getTime()) return oldest;
  return defaultDateFrom;
}

/**
 * issue 492: JEDINÝ zdroj pravdy pre okná importu objednávok — DRY-uje inak
 * duplikovanú (a NETESTOVANÚ) drôtovú logiku z `cli/orders-ingest.ts` aj
 * `index.ts`, aby sa už NIKDY nemohli rozísť (a aby ju šlo unit-testovať —
 * presne trieda tichého regresu, ktorý #492 spôsobil). `exportDateFrom` (CSV
 * export + `windowStart` akceptačnej brány) sa rozšíri na najstaršiu OTVORENÚ
 * objednávku (#492); `idsDateFrom` (XML id-fetch) LEN keď existuje XML URL, a
 * počítané z PREDVOLENÉHO okna (nezmenené #132 správanie). `dateUntil` je
 * spoločné pre oba fetche.
 */
export interface OrdersIngestWindows {
  readonly exportDateFrom: Date;
  readonly idsDateFrom: Date;
  readonly dateUntil: Date;
}

export async function computeOrdersIngestWindows(
  db: Pick<Database, "select">,
  now: Date,
  opts: { readonly hasXmlUrl: boolean },
): Promise<OrdersIngestWindows> {
  const { dateFrom, dateUntil } = computeImportWindow(now, DEFAULT_ORDERS_IMPORT_WINDOW_DAYS);
  const exportDateFrom = await computeOrdersExportWindowStart(db, dateFrom);
  const idsDateFrom = opts.hasXmlUrl ? await computeOrderIdsWindowStart(db, dateFrom) : dateFrom;
  return { exportDateFrom, idsDateFrom, dateUntil };
}
