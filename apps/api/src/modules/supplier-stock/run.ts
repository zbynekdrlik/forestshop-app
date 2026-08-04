// Beh scrapera dostupnosti u dodávateľa (issue 212, per veľkosť issue 224).
//
// Sériový, zámerne: 969 z 1 210 riadkov reálneho exportu je JEDNA doména
// (`huntingshop.eu`), takže paralelné sťahovanie by na ňu vyzeralo ako útok.
// Medzi dvomi požiadavkami na tú istú doménu je pauza (`PER_HOST_DELAY_MS`).

import { and, eq, isNotNull, notInArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { products, supplierStock, variants } from "../../db/schema.js";
import { extractSupplierLink } from "../catalog/supplier-link.js";
import { MAX_AGE_HOURS, PER_HOST_DELAY_MS, SUPPLIER_STOCK_RUN_LOCK_KEY } from "./constants.js";
import type { PageFetcher } from "./page-fetcher.js";
import {
  hostOf,
  matchSizeLabel,
  parsePage,
  parseSizeAvailability,
  type SupplierAvailability,
  type SupplierStockSource,
} from "./parse.js";

export interface SupplierStockRunResult {
  /** Koľko unikátnych liniek katalóg vôbec obsahuje. */
  readonly total: number;
  /** Preskočené, lebo majú čerstvú úspešnú kontrolu. */
  readonly skipped: number;
  readonly checked: number;
  /** Počty sú za ZAPÍSANÉ riadky (link, veľkosť), nie za linky — rovnaká
   * jednotka ako `getSupplierStockOverview` (`queries.ts`), takže si oba
   * súhlasia. Jednoveľkostná/blanket linka prispieva presne 1, linka s
   * pravidlom na veľkosti prispieva po jednej za KAŽDÚ našu veľkosť. */
  readonly available: number;
  readonly unavailable: number;
  readonly unknown: number;
  /** Kontrola sama zlyhala (sieť, časový limit, HTTP chyba) — za LINKU. */
  readonly failed: number;
  readonly hosts: readonly string[];
}

export interface RunSupplierStockOptions {
  readonly db: Database;
  readonly now: Date;
  readonly fetchPage: PageFetcher;
  /** Iba pre testy — bez neho beh reálne čaká medzi doménami. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Iba pre testy/ručný beh — obmedzí počet skutočne kontrolovaných liniek. */
  readonly limit?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Unikátne dodávateľské linky z katalógu, v stabilnom poradí. */
export async function collectSupplierLinks(db: Database): Promise<readonly string[]> {
  const rows = await db
    .select({ internalNote: products.internalNote })
    .from(products)
    .where(isNotNull(products.internalNote));
  const links = new Set<string>();
  for (const row of rows) {
    const url = extractSupplierLink(row.internalNote).url;
    if (url !== null && hostOf(url) !== "") links.add(url);
  }
  return [...links].sort((a, b) => a.localeCompare(b));
}

/**
 * NAŠE `variant.size_label` hodnoty zoskupené podľa dodávateľskej linky
 * (issue 224) — čo touto linkou treba spárovať, keď má doména pravidlo na
 * čítanie zoznamu veľkostí (`parseSizeAvailability`). Variant bez veľkosti
 * (`null`/prázdne) sa NEZAHRNIE — nedal by sa spárovať a písal by
 * zavádzajúci blanket (`''`) riadok popri riadkoch ostatných veľkostí tej
 * istej linky (viď `writeSupplierStockRows`).
 */
async function collectOurSizesByLink(db: Database): Promise<Map<string, readonly string[]>> {
  const rows = await db
    .select({ internalNote: products.internalNote, sizeLabel: variants.sizeLabel })
    .from(variants)
    .innerJoin(products, eq(variants.productKey, products.key));
  const byLink = new Map<string, Set<string>>();
  for (const row of rows) {
    const url = extractSupplierLink(row.internalNote).url;
    if (url === null || hostOf(url) === "") continue;
    const label = (row.sizeLabel ?? "").trim();
    if (label === "") continue;
    const set = byLink.get(url) ?? new Set<string>();
    set.add(label);
    byLink.set(url, set);
  }
  return new Map([...byLink].map(([link, set]) => [link, [...set]]));
}

/**
 * `true`, keď má linka ÚSPEŠNÚ kontrolu mladšiu než `MAX_AGE_HOURS`.
 * Zlyhaná kontrola sa zámerne NEPOČÍTA — inak by stránka, ktorá stabilne
 * padá na časovom limite, ostala „čerstvá" a nikdy by sa neskúsila znova.
 */
export function isFresh(
  previous: { readonly ok: boolean; readonly confirmedAt: Date | null } | undefined,
  now: Date,
  maxAgeHours = MAX_AGE_HOURS,
): boolean {
  if (previous === undefined || !previous.ok || previous.confirmedAt === null) return false;
  const ageMs = now.getTime() - previous.confirmedAt.getTime();
  return ageMs >= 0 && ageMs <= maxAgeHours * 3_600_000;
}

export async function runSupplierStock(options: RunSupplierStockOptions): Promise<SupplierStockRunResult> {
  const { db } = options;
  const lockClient = await db.$client.connect();
  try {
    await lockClient.query("select pg_advisory_lock($1)", [SUPPLIER_STOCK_RUN_LOCK_KEY]);
    return await runSupplierStockLocked(options);
  } finally {
    await lockClient.query("select pg_advisory_unlock($1)", [SUPPLIER_STOCK_RUN_LOCK_KEY]);
    lockClient.release();
  }
}

interface StockRowInput {
  readonly sizeLabel: string;
  readonly availability: SupplierAvailability;
  readonly availabilityText: string;
  readonly price: number | null;
  readonly source: SupplierStockSource;
}

async function runSupplierStockLocked(options: RunSupplierStockOptions): Promise<SupplierStockRunResult> {
  const { db, now, fetchPage } = options;
  const sleep = options.sleep ?? defaultSleep;

  const links = await collectSupplierLinks(db);
  const ourSizesByLink = await collectOurSizesByLink(db);
  // Všetky riadky tej istej linky sa píšu/aktualizujú v TOM ISTOM behu
  // (`writeSupplierStockRows`), takže "je táto linka čerstvá" musí platiť
  // pre KAŽDÝ jej riadok naraz — keby čo i len jedna veľkosť ešte nemala
  // čerstvé potvrdenie, celá linka sa musí skúsiť znova (jeden fetch aj tak
  // vždy prepíše všetky veľkosti tej istej linky).
  const existing = await db
    .select({ link: supplierStock.link, ok: supplierStock.ok, confirmedAt: supplierStock.confirmedAt })
    .from(supplierStock);
  const rowsByLink = new Map<string, { readonly ok: boolean; readonly confirmedAt: Date | null }[]>();
  for (const row of existing) {
    const rows = rowsByLink.get(row.link) ?? [];
    rows.push(row);
    rowsByLink.set(row.link, rows);
  }
  const isLinkFresh = (link: string): boolean => {
    const rows = rowsByLink.get(link);
    return rows !== undefined && rows.length > 0 && rows.every((row) => isFresh(row, now));
  };

  const counts = { available: 0, unavailable: 0, unknown: 0, failed: 0 };
  const hosts = new Set<string>();
  const lastFetchByHost = new Map<string, number>();
  let skipped = 0;
  let checked = 0;

  for (const link of links) {
    const host = hostOf(link);
    hosts.add(host);
    if (isLinkFresh(link)) {
      skipped += 1;
      continue;
    }
    if (options.limit !== undefined && checked >= options.limit) {
      skipped += 1;
      continue;
    }

    // Slušnosť: pauza sa počíta od POSLEDNEJ požiadavky na TÚ ISTÚ doménu,
    // nie paušálne medzi všetkými — striedanie domén tak nie je trestané.
    const last = lastFetchByHost.get(host);
    if (last !== undefined) {
      const waitMs = PER_HOST_DELAY_MS - (Date.now() - last);
      if (waitMs > 0) await sleep(waitMs);
    }
    const fetched = await fetchPage(link);
    lastFetchByHost.set(host, Date.now());
    checked += 1;

    if (!fetched.ok) {
      counts.failed += 1;
      // Zlyhaná kontrola vymaže PRÍPADNÉ predošlé per-veľkostné riadky tejto
      // linky a nahradí ich jediným blanket "neviem" riadkom (rovnaká
      // filozofia ako pôvodný jednoriadkový model — `ok=false` samo osebe
      // vylučuje kandidatúru v `restock/queries.ts` bez ohľadu na
      // dostupnosť, takže to nič neoslabuje). Nasledujúci ÚSPEŠNÝ beh riadky
      // po veľkostiach znova odvodí.
      await writeSupplierStockRows(db, {
        link,
        host,
        now,
        ok: false,
        error: fetched.error,
        httpStatus: fetched.httpStatus,
        rows: [{ sizeLabel: "", availability: "unknown", availabilityText: "", price: null, source: "none" }],
      });
      continue;
    }

    const ourSizes = ourSizesByLink.get(link) ?? [];
    const sizeList = parseSizeAvailability(fetched.html, link);

    let rows: readonly StockRowInput[];
    if (sizeList !== null && ourSizes.length > 0) {
      const pageParsed = parsePage(fetched.html, link);
      rows = ourSizes.map((ourLabel) => {
        const matched = matchSizeLabel(ourLabel, sizeList.map((s) => s.sizeLabel));
        const hit = matched === null ? null : (sizeList.find((s) => s.sizeLabel === matched) ?? null);
        return {
          sizeLabel: ourLabel,
          availability: hit?.availability ?? "unknown",
          availabilityText: hit?.sizeLabel ?? "",
          price: pageParsed.price,
          source: hit !== null ? "size_list" : "none",
        };
      });
    } else {
      const pageParsed = parsePage(fetched.html, link);
      rows = [
        {
          sizeLabel: "",
          availability: pageParsed.availability,
          availabilityText: pageParsed.availabilityText,
          price: pageParsed.price,
          source: pageParsed.source,
        },
      ];
    }

    for (const row of rows) counts[row.availability] += 1;
    await writeSupplierStockRows(db, {
      link,
      host,
      now,
      ok: true,
      error: null,
      httpStatus: fetched.httpStatus,
      rows,
    });
  }

  return {
    total: links.length,
    skipped,
    checked,
    available: counts.available,
    unavailable: counts.unavailable,
    unknown: counts.unknown,
    failed: counts.failed,
    hosts: [...hosts].sort((a, b) => a.localeCompare(b)),
  };
}

type SupplierStockInsert = typeof supplierStock.$inferInsert;

// `Pick<Database, "insert" | "delete">` (nie celý `Database`) — rovnaký vzor
// ako `audit/service.ts`'s `AuditExecutor` (`.claude/rules/database.md`):
// `tx` z `db.transaction(async (tx) => ...)` má `PgTransaction`, ktorý má
// `.insert()`/`.delete()` rovnakého tvaru, ale chýba mu `Database`'s vlastné
// `$client`, takže by ho `tsc` odmietol ako argument typu `Database`.
type SupplierStockWriter = Pick<Database, "insert" | "delete">;

/**
 * Zapíše VŠETKY riadky tejto linky pre tento beh a vymaže zvyšné (issue 224)
 * — inak by po zmene stratégie (napr. produkt medzičasom dostal viac
 * veľkostí, alebo naopak) ostal v tabuľke zavádzajúci riadok z predošlého
 * behu, ktorý by `restock/queries.ts`'s JOIN mohol nesprávne spárovať s
 * iným variantom (fallback na `size_label=''`). Mazanie + zápisy bežia v
 * JEDNEJ transakcii (code review, issue 224) — inak by prerušený beh (pád
 * procesu) mohol nechať linku len s ČASŤOU jej veľkostí zapísanou; taká
 * čiastočná množina by `isLinkFresh` vyhodnotil ako "čerstvá" (všetky
 * PRÍTOMNÉ riadky sú fresh) a chýbajúce veľkosti by sa neskúsili znova až do
 * vypršania `MAX_AGE_HOURS`.
 */
async function writeSupplierStockRows(
  db: Database,
  args: {
    readonly link: string;
    readonly host: string;
    readonly now: Date;
    readonly ok: boolean;
    readonly error: string | null;
    readonly httpStatus: number | null;
    readonly rows: readonly StockRowInput[];
  },
): Promise<void> {
  const { link, host, now, ok, error, httpStatus, rows } = args;
  const wantedSizes = rows.map((r) => r.sizeLabel);
  await db.transaction(async (tx) => {
    await tx.delete(supplierStock).where(and(eq(supplierStock.link, link), notInArray(supplierStock.sizeLabel, wantedSizes)));
    for (const row of rows) {
      await upsert(tx, {
        link,
        sizeLabel: row.sizeLabel,
        host,
        availability: row.availability,
        availabilityText: row.availabilityText,
        price: row.price === null ? null : row.price.toFixed(2),
        source: row.source,
        ok,
        error,
        httpStatus,
        checkedAt: now,
        // Iba SKUTOČNE určená dostupnosť je potvrdenie. `unknown` znamená
        // „stránka sa načítala, ale nič sme sa nedozvedeli" — to nesmie
        // predlžovať platnosť predošlého „skladom". Zlyhaná kontrola (ok=false)
        // rovnako nikdy nepotvrdzuje.
        confirmedAt: ok && row.availability !== "unknown" ? now : null,
      });
    }
  });
}

async function upsert(db: SupplierStockWriter, row: SupplierStockInsert): Promise<void> {
  await db
    .insert(supplierStock)
    .values(row)
    .onConflictDoUpdate({
      target: [supplierStock.link, supplierStock.sizeLabel],
      set: {
        host: row.host,
        availability: row.availability,
        availabilityText: row.availabilityText,
        price: row.price,
        source: row.source,
        ok: row.ok,
        error: row.error,
        httpStatus: row.httpStatus,
        checkedAt: row.checkedAt,
        // `confirmedAt` sa pri zlyhaní/`unknown` NEPREPÍŠE na `null` —
        // predošlé potvrdenie si má dožiť svoju 48-hodinovú platnosť
        // (issue 213), nie zmiznúť pri prvom výpadku siete.
        ...(row.confirmedAt === null ? {} : { confirmedAt: row.confirmedAt }),
      },
    });
}
