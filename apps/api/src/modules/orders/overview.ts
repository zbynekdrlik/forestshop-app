import { and, gte, ne } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orders } from "../../db/schema.js";
import { getZonedDateParts } from "../../timezone.js";
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

// Rovnaká hodnota ako `modules/posta-uncollected/constants.ts`'s
// `CANCELLED_STATUSES` (`new Set(["Stornovaná"])`) — VEDOME NEZDIEĽANÁ:
// import odtiaľ SEM by obrátil prirodzený smer závislosti (`orders` je
// základnejší modul, `posta-uncollected` je na ňom postavený). Ak niekedy
// pribudne TRETIE miesto potrebujúce tento literál, hoď ho do vlastného
// zdieľaného miesta vnútri `orders` modulu (napr. vedľa `open-statuses.ts`)
// a nechaj `posta-uncollected` importovať odtiaľ — nie naopak.
const STORNO_STATUS_NAME = "Stornovaná";

/**
 * "Dnes" v Europe/Bratislava, vrátené ako UTC `Date` (dolná hranica
 * intervalu `>= hranica`). Zámerne ZNOVA POUŽÍVA `timezone.ts`'s zdieľanú
 * `getZonedDateParts` (namiesto vlastného `Intl.DateTimeFormat` volania) a
 * `parser.ts`'s `parseShopLocalDateTime` (naivný lokálny čas → UTC,
 * DST-vedomé, `Intl.DateTimeFormat`-guess-format-diff trik) — vytvorí
 * kandidátny "YYYY-MM-DD 00:00:00" reťazec a nechá ho previesť už
 * existujúcou, otestovanou funkciou.
 */
function localMidnightUtc(now: Date, timeZone: string): Date {
  const { year, month, day } = getZonedDateParts(now, timeZone);
  const pad = (n: number): string => String(n).padStart(2, "0");
  // `parseShopLocalDateTime` nikdy nevráti `null` pre vstup, ktorý SAMA táto
  // funkcia zostavila v presnom `DATETIME_RE` tvare.
  return parseShopLocalDateTime(`${String(year)}-${pad(month)}-${pad(day)} 00:00:00`, timeZone) as Date;
}

/**
 * `now` mínus presne 1 kalendárny mesiac V DANOM PÁSME (Europe/Bratislava),
 * s CLAMPOM na posledný deň cieľového mesiaca (rovnaké správanie ako
 * Postgres-ov `timestamp - interval '1 month'`, overené priamo v produkčnej
 * DB: `date '2026-03-31' - interval '1 month'` = `2026-02-28`, NIE prepad do
 * marca).
 *
 * KRITICKY dôležité — narozdiel od "týždňa" (čistá 7×24h dĺžka trvania,
 * TZ-nezávislá), "mesiac" JE kalendárny pojem, takže MUSÍ počítať v
 * MIESTNOM (Bratislava) kalendári, nie v UTC (code review na issue 407 —
 * prvý pokus autora počítal cez `date.getUTC*()`, čo by ~2 hodiny denne
 * (rozdiel UTC vs. CEST, v zime 1 hodinu) — presne okolo miestnej polnoci —
 * odvodilo hranicu z NESPRÁVNEHO kalendárneho dňa/mesiaca, keďže UTC deň sa
 * mení až 1-2 hodiny PO miestnej polnoci). Preto rovnaký vzor ako
 * `localMidnightUtc` vyššie: rozlož `now` na MIESTNE kalendárne/časové
 * zložky (`getZonedDateParts`), počítaj clamp na nich, zostav kandidátny
 * "YYYY-MM-DD HH:mm:ss" miestny reťazec a nechaj `parseShopLocalDateTime`
 * previesť späť na UTC (DST-vedomé, rovnaká funkcia ako všade inde v tomto
 * module).
 */
function subtractOneMonthClamped(now: Date, timeZone: string): Date {
  const { year, month, day, hour, minute, second } = getZonedDateParts(now, timeZone);

  let targetYear = year;
  let targetMonth = month - 1; // `month` je 1-12; 1 (január) − 1 = 0 → preklopiť na december minulého roka
  if (targetMonth < 1) {
    targetMonth = 12;
    targetYear -= 1;
  }
  // Počet dní v cieľovom mesiaci — čisto kalendárny fakt (nezávislý od
  // pásma), preto bezpečné počítať cez `Date.UTC`. `targetMonth` (1-12) sa
  // dá priamo použiť ako 0-indexovaný "nasledujúci mesiac" argument — deň 0
  // toho mesiaca JE posledný deň cieľového mesiaca.
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const clampedDay = Math.min(day, daysInTargetMonth);

  const pad = (n: number): string => String(n).padStart(2, "0");
  const localCandidate = `${String(targetYear)}-${pad(targetMonth)}-${pad(clampedDay)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
  // `parseShopLocalDateTime` nikdy nevráti `null` pre vstup v presnom
  // `DATETIME_RE` tvare, ktorý sama táto funkcia zostavila.
  return parseShopLocalDateTime(localCandidate, timeZone) as Date;
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
  const month = subtractOneMonthClamped(now, timeZone);

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
