import { gte } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orders } from "../../db/schema.js";
import { parseShopLocalDateTime } from "./parser.js";

// issue 237: "Prehľad e-shopu" na obrazovke "Na objednanie" — počet
// objednávok + tržba za dnes/tento týždeň/tento mesiac, presne to, čo ukazuje
// Shoptet-ov vlastný dashboard. Zámerne SAMOSTATNÝ modul od `queries.ts` (ten
// je celý o "Na objednanie"'s OPEN-status pracovnom zozname cez `order_line`
// JOIN) — tento dopyt číta PRIAMO `order` tabuľku, bez ohľadu na
// `status_name`, lebo ide o celoobchodnú štatistiku, nie o dodávateľský
// zoznam.

/**
 * Hranice "dnes"/"tento týždeň" (pondelok)/"tento mesiac" v Europe/Bratislava,
 * vrátené ako UTC `Date` (dolná hranica intervalu `>= hranica`). Zámerne
 * ZNOVA POUŽÍVA `parser.ts`'s `parseShopLocalDateTime` (naivný lokálny čas →
 * UTC, DST-vedomé, `Intl.DateTimeFormat`-guess-format-diff trik) namiesto
 * vlastnej reimplementácie tej istej offset aritmetiky — vytvorí kandidátny
 * "YYYY-MM-DD 00:00:00" reťazec a nechá ho previesť už existujúcou,
 * otestovanou funkciou.
 */
export function computeBratislavaPeriodBoundaries(
  now: Date,
  timeZone = "Europe/Bratislava",
): { readonly today: Date; readonly week: Date; readonly month: Date } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(now);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const year = get("year");
  const month = get("month");
  const day = get("day");

  const pad = (n: number): string => String(n).padStart(2, "0");
  const localMidnightUtc = (y: number, mo: number, d: number): Date => {
    // `parseShopLocalDateTime` nikdy nevráti `null` pre vstup, ktorý SAMA
    // táto funkcia zostavila v presnom `DATETIME_RE` tvare.
    return parseShopLocalDateTime(`${String(y)}-${pad(mo)}-${pad(d)} 00:00:00`, timeZone) as Date;
  };

  const today = localMidnightUtc(year, month, day);

  // `getUTCDay()` na ČISTOM kalendárnom dátume (bez časovej zložky, teda bez
  // zónového posunu) — 0 = nedeľa .. 6 = sobota. ISO týždeň začína
  // pondelkom, takže `(dow + 6) % 7` je počet dní od najbližšieho pondelka.
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  const weekDate = new Date(Date.UTC(year, month - 1, day - daysSinceMonday));
  const week = localMidnightUtc(weekDate.getUTCFullYear(), weekDate.getUTCMonth() + 1, weekDate.getUTCDate());

  const monthStart = localMidnightUtc(year, month, 1);

  return { today, week, month: monthStart };
}

/**
 * Súčet `numeric` reťazcov (`"1234.56"`, drizzle ich drží ako reťazec) CEZ
 * BigInt centy — nikdy cez `number`, rovnaká disciplína ako `catalog/
 * money.ts` (žiadna binárna chyba zaokrúhlenia pri sčítaní desiatok/stoviek
 * súm). `null`/nečitateľná hodnota sa do súčtu nezaráta (0), nikdy nezhodí
 * celý výpočet — dashboard má radšej čiastočnú tržbu než žiadnu.
 */
export function sumMoneyCents(values: readonly (string | null)[]): string {
  let totalCents = 0n;
  for (const raw of values) {
    if (raw === null) continue;
    const negative = raw.startsWith("-");
    const unsigned = negative ? raw.slice(1) : raw;
    const dot = unsigned.indexOf(".");
    const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
    const fracPart = (dot === -1 ? "" : unsigned.slice(dot + 1)).padEnd(2, "0").slice(0, 2);
    if (!/^\d+$/.test(intPart) || !/^\d*$/.test(fracPart)) continue;
    const cents = BigInt(intPart) * 100n + BigInt(fracPart === "" ? "0" : fracPart);
    totalCents += negative ? -cents : cents;
  }
  const negative = totalCents < 0n;
  const abs = negative ? -totalCents : totalCents;
  const centsStr = abs.toString().padStart(3, "0");
  const intOut = centsStr.slice(0, -2);
  const fracOut = centsStr.slice(-2);
  return `${negative ? "-" : ""}${intOut}.${fracOut}`;
}

export interface OrdersPeriodStats {
  readonly orderCount: number;
  readonly revenue: string;
}

export interface OrdersDashboardOverview {
  readonly today: OrdersPeriodStats;
  readonly week: OrdersPeriodStats;
  readonly month: OrdersPeriodStats;
}

/**
 * "Prehľad e-shopu" — počet objednávok + tržba (`total_price_with_vat`) za
 * dnes/tento týždeň/tento mesiac, počítané zo VŠETKÝCH objednávok v danom
 * okne (bez ohľadu na `status_name`), presne ako Shoptet-ov vlastný
 * dashboard. Jeden dopyt (najširšie okno = mesiac), bucketovanie do troch
 * období beží v JS — objem (rádovo stovky objednávok/mesiac) je malý, žiadny
 * dôvod na tri samostatné dopyty/SQL `FILTER`.
 */
export async function getOrdersDashboardOverview(db: Database, now: Date): Promise<OrdersDashboardOverview> {
  const boundaries = computeBratislavaPeriodBoundaries(now);

  const rows = await db
    .select({ placedAt: orders.placedAt, totalPriceWithVat: orders.totalPriceWithVat })
    .from(orders)
    .where(gte(orders.placedAt, boundaries.month));

  const bucket = (from: Date): OrdersPeriodStats => {
    const inBucket = rows.filter((r) => r.placedAt >= from);
    return {
      orderCount: inBucket.length,
      revenue: sumMoneyCents(inBucket.map((r) => r.totalPriceWithVat)),
    };
  };

  return {
    today: bucket(boundaries.today),
    week: bucket(boundaries.week),
    month: bucket(boundaries.month),
  };
}
