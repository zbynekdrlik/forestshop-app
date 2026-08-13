import { and, gte, ne } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orders } from "../../db/schema.js";
import { parseShopLocalDateTime } from "./parser.js";

// issue 237: "Prehľad e-shopu" na obrazovke "Na objednanie" — počet
// objednávok + tržba za dnes/tento týždeň/tento mesiac, presne to, čo ukazuje
// Shoptet-ov vlastný dashboard. Zámerne SAMOSTATNÝ modul od `queries.ts` (ten
// je celý o "Na objednanie"'s OPEN-status pracovnom zozname cez `order_line`
// JOIN) — tento dopyt číta PRIAMO `order` tabuľku.
//
// issue 407 (majiteľ: "tieto čísla mi nejako nesedia oproti shoptetu"):
// appka pôvodne počítala "Týždeň"/"Mesiac" ako KALENDÁRNE okná (pondelok
// tohto týždňa / 1. deň tohto mesiaca) — naživo overené (produkčná DB,
// ticketov komentár): appky pôvodné čísla PRESNE sedeli s kalendárnymi
// oknami, kým Shoptet ukazoval iné, vyššie čísla. Binárnym hľadaním hranice
// v produkčnej DB sa zistilo, že Shoptet ráta KĹZAVÉ (rolling) okná od
// AKTUÁLNEHO okamihu — `now - 7 dní` / `now - 1 kalendárny mesiac` dali
// PRESNE Shoptetove čísla (na cent zhodné po jeho zaokrúhlení na celé
// eurá). "Dnes" OSTÁVA kalendárny deň (Europe/Bratislava miestna polnoc) —
// Shoptet ukazuje SAMOSTATNÚ "24 hodín" dlaždicu odlišnú od svojej "Dnes"
// dlaždice v tom istom momente, čo dokazuje, že jeho "Dnes" je kalendárny
// deň, nie kĺzavých 24 hodín. Plné dôkazy (SQL dopyty, presné čísla) v
// issue 407's komentári.

const STORNO_STATUS_NAME = "Stornovaná";

/**
 * "Dnes" v Europe/Bratislava, vrátené ako UTC `Date` (dolná hranica
 * intervalu `>= hranica`). Zámerne ZNOVA POUŽÍVA `parser.ts`'s
 * `parseShopLocalDateTime` (naivný lokálny čas → UTC, DST-vedomé,
 * `Intl.DateTimeFormat`-guess-format-diff trik) namiesto vlastnej
 * reimplementácie tej istej offset aritmetiky — vytvorí kandidátny
 * "YYYY-MM-DD 00:00:00" reťazec a nechá ho previesť už existujúcou,
 * otestovanou funkciou.
 */
function localMidnightUtc(now: Date, timeZone: string): Date {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(now);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const pad = (n: number): string => String(n).padStart(2, "0");
  // `parseShopLocalDateTime` nikdy nevráti `null` pre vstup, ktorý SAMA táto
  // funkcia zostavila v presnom `DATETIME_RE` tvare.
  return parseShopLocalDateTime(`${String(get("year"))}-${pad(get("month"))}-${pad(get("day"))} 00:00:00`, timeZone) as Date;
}

/**
 * `date` mínus presne 1 kalendárny mesiac, s CLAMPOM na posledný deň
 * cieľového mesiaca (rovnaké správanie ako Postgres-ov `timestamp - interval
 * '1 month'`, overené priamo v produkčnej DB: `date '2026-03-31' - interval
 * '1 month'` = `2026-02-28`, NIE prepad do marca) — na rozdiel od JS
 * `Date.prototype.setUTCMonth`, ktorý by prepočítaný deň mimo cieľového
 * mesiaca ticho PRETIEKOL do nasledujúceho mesiaca (31.3. − 1 mesiac by dal
 * 3.3., nie 28.2.). Operuje na UTC kalendárnych poliach okamihu — žiadna
 * TZ-konverzia netreba, keďže ide o čisté odčítanie trvania od okamihu, nie
 * o miestnu polnoc (na rozdiel od `localMidnightUtc` vyššie).
 */
function subtractOneMonthClamped(date: Date): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  let targetYear = year;
  let targetMonth = month - 1;
  if (targetMonth < 0) {
    targetMonth = 11;
    targetYear -= 1;
  }
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(date.getUTCDate(), daysInTargetMonth);
  return new Date(
    Date.UTC(targetYear, targetMonth, clampedDay, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()),
  );
}

/**
 * Hranice "dnes" (kalendárny deň, Europe/Bratislava)/"tento týždeň" (kĺzavých
 * posledných 7 dní)/"tento mesiac" (kĺzavý posledný kalendárny mesiac) —
 * vrátené ako UTC `Date` (dolná hranica intervalu `>= hranica`). Pozri
 * modulový komentár vyššie (issue 407) pre dôvod, prečo "týždeň"/"mesiac" sú
 * kĺzavé, kým "dnes" ostáva kalendárne.
 */
export function computeOrdersDashboardBoundaries(
  now: Date,
  timeZone = "Europe/Bratislava",
): { readonly today: Date; readonly week: Date; readonly month: Date } {
  const today = localMidnightUtc(now, timeZone);
  const week = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const month = subtractOneMonthClamped(now);

  return { today, week, month };
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
 * okne OKREM stornovaných (`status_name != 'Stornovaná'`), presne ako
 * Shoptet-ov vlastný dashboard (issue 407 — naživo overené: Shoptet
 * stornované objednávky do POČTU nezaráta; na TRŽBU to v našich dátach
 * dnes vplyv nemá, keďže každá stornovaná objednávka tu má
 * `total_price_with_vat = 0.00`, ale filter je explicitný a nespolieha sa
 * na túto zhodu). Jeden dopyt (najširšie okno = mesiac), bucketovanie do
 * troch období beží v JS — objem (rádovo stovky objednávok/mesiac) je malý,
 * žiadny dôvod na tri samostatné dopyty/SQL `FILTER`.
 */
export async function getOrdersDashboardOverview(db: Database, now: Date): Promise<OrdersDashboardOverview> {
  const boundaries = computeOrdersDashboardBoundaries(now);

  const rows = await db
    .select({ placedAt: orders.placedAt, totalPriceWithVat: orders.totalPriceWithVat })
    .from(orders)
    .where(and(gte(orders.placedAt, boundaries.month), ne(orders.statusName, STORNO_STATUS_NAME)));

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
