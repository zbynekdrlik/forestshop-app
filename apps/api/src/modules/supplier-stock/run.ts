// Beh scrapera dostupnosti u dodávateľa (issue 212).
//
// Sériový, zámerne: 969 z 1 210 riadkov reálneho exportu je JEDNA doména
// (`huntingshop.eu`), takže paralelné sťahovanie by na ňu vyzeralo ako útok.
// Medzi dvomi požiadavkami na tú istú doménu je pauza (`PER_HOST_DELAY_MS`).

import { isNotNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { products, supplierStock } from "../../db/schema.js";
import { extractSupplierLink } from "../catalog/supplier-link.js";
import { MAX_AGE_HOURS, PER_HOST_DELAY_MS, SUPPLIER_STOCK_RUN_LOCK_KEY } from "./constants.js";
import type { PageFetcher } from "./page-fetcher.js";
import { hostOf, parsePage } from "./parse.js";

export interface SupplierStockRunResult {
  /** Koľko unikátnych liniek katalóg vôbec obsahuje. */
  readonly total: number;
  /** Preskočené, lebo majú čerstvú úspešnú kontrolu. */
  readonly skipped: number;
  readonly checked: number;
  readonly available: number;
  readonly unavailable: number;
  readonly unknown: number;
  /** Kontrola sama zlyhala (sieť, časový limit, HTTP chyba). */
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

async function runSupplierStockLocked(options: RunSupplierStockOptions): Promise<SupplierStockRunResult> {
  const { db, now, fetchPage } = options;
  const sleep = options.sleep ?? defaultSleep;

  const links = await collectSupplierLinks(db);
  const existing = await db
    .select({ link: supplierStock.link, ok: supplierStock.ok, confirmedAt: supplierStock.confirmedAt })
    .from(supplierStock);
  const previousByLink = new Map(existing.map((row) => [row.link, row]));

  const counts = { available: 0, unavailable: 0, unknown: 0, failed: 0 };
  const hosts = new Set<string>();
  const lastFetchByHost = new Map<string, number>();
  let skipped = 0;
  let checked = 0;

  for (const link of links) {
    const host = hostOf(link);
    hosts.add(host);
    if (isFresh(previousByLink.get(link), now)) {
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
      await upsert(db, {
        link,
        host,
        availability: "unknown",
        availabilityText: "",
        price: null,
        source: "none",
        ok: false,
        error: fetched.error,
        httpStatus: fetched.httpStatus,
        checkedAt: now,
        // Zlyhaná kontrola NIKDY neposúva `confirmedAt` — staré potvrdenie
        // musí zostarnúť a automatizácia ho prestane brať (issue 213).
        confirmedAt: null,
      });
      continue;
    }

    const parsed = parsePage(fetched.html, link);
    counts[parsed.availability] += 1;
    await upsert(db, {
      link,
      host,
      availability: parsed.availability,
      availabilityText: parsed.availabilityText,
      price: parsed.price === null ? null : parsed.price.toFixed(2),
      source: parsed.source,
      ok: true,
      error: null,
      httpStatus: fetched.httpStatus,
      checkedAt: now,
      // Iba SKUTOČNE určená dostupnosť je potvrdenie. `unknown` znamená
      // „stránka sa načítala, ale nič sme sa nedozvedeli" — to nesmie
      // predlžovať platnosť predošlého „skladom".
      confirmedAt: parsed.availability === "unknown" ? null : now,
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

type SupplierStockRow = typeof supplierStock.$inferInsert;

async function upsert(db: Database, row: SupplierStockRow): Promise<void> {
  await db
    .insert(supplierStock)
    .values(row)
    .onConflictDoUpdate({
      target: supplierStock.link,
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
