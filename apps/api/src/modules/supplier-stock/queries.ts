// Čítanie pre obrazovku "Dodávateľský sklad" (issue 212). Vždy ŽIVÝ dopyt nad
// `supplier_stock`, nikdy `job_run.detail` cache — tabuľka je tu práve preto,
// aby stav dostupnosti prežil aj medzi behmi (na rozdiel od `nedostupne`,
// ktoré žiadny stav medzi behmi nedrží).

import { asc, desc, eq, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { supplierStock } from "../../db/schema.js";

export interface SupplierStockOverview {
  readonly total: number;
  readonly available: number;
  readonly unavailable: number;
  readonly unknown: number;
  readonly failed: number;
  readonly lastCheckedAt: Date | null;
}

export interface SupplierStockRow {
  readonly link: string;
  // '' = dostupnosť CELÉHO odkazu (issue 224) — jednoveľkostný produkt,
  // alebo doména bez pravidla na čítanie zoznamu veľkostí.
  readonly sizeLabel: string;
  readonly host: string;
  readonly availability: "available" | "unavailable" | "unknown";
  readonly availabilityText: string;
  readonly price: string | null;
  readonly source: "json_ld" | "meta" | "text" | "size_list" | "none";
  readonly ok: boolean;
  readonly error: string | null;
  readonly httpStatus: number | null;
  readonly checkedAt: Date;
  readonly confirmedAt: Date | null;
}

/** Ukážkový odkaz + KTORÁ naša veľkosť sa naň nepodarilo spárovať (issue 224). */
export interface UnreadableSample {
  readonly link: string;
  /** '' = celý odkaz (bez rozlíšenia veľkosti), nikdy nesúčasť `href`u. */
  readonly sizeLabel: string;
}

/** Jeden riadok na doménu, ktorú sa nedarí čítať — karta pre majiteľa. */
export interface UnreadableHost {
  readonly host: string;
  readonly count: number;
  /** Ukážky (max 5), aby sa dalo hneď kliknúť a pozrieť sa. */
  readonly samples: readonly UnreadableSample[];
}

export async function getSupplierStockOverview(db: Database): Promise<SupplierStockOverview> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      available: sql<number>`count(*) filter (where ${supplierStock.ok} and ${supplierStock.availability} = 'available')::int`,
      unavailable: sql<number>`count(*) filter (where ${supplierStock.ok} and ${supplierStock.availability} = 'unavailable')::int`,
      unknown: sql<number>`count(*) filter (where ${supplierStock.ok} and ${supplierStock.availability} = 'unknown')::int`,
      failed: sql<number>`count(*) filter (where not ${supplierStock.ok})::int`,
      lastCheckedAt: sql<Date | null>`max(${supplierStock.checkedAt})`,
    })
    .from(supplierStock);
  return (
    row ?? { total: 0, available: 0, unavailable: 0, unknown: 0, failed: 0, lastCheckedAt: null }
  );
}

export async function listSupplierStock(db: Database, limit = 500): Promise<readonly SupplierStockRow[]> {
  return db
    .select({
      link: supplierStock.link,
      sizeLabel: supplierStock.sizeLabel,
      host: supplierStock.host,
      availability: supplierStock.availability,
      availabilityText: supplierStock.availabilityText,
      price: supplierStock.price,
      source: supplierStock.source,
      ok: supplierStock.ok,
      error: supplierStock.error,
      httpStatus: supplierStock.httpStatus,
      checkedAt: supplierStock.checkedAt,
      confirmedAt: supplierStock.confirmedAt,
    })
    .from(supplierStock)
    .orderBy(asc(supplierStock.host), asc(supplierStock.link), asc(supplierStock.sizeLabel))
    .limit(limit);
}

/**
 * Domény, kde sa dostupnosť NEDÁ prečítať — buď stránka odpovedala, ale nič
 * sa z nej nedalo vyčítať (`unknown`), alebo kontrola sama zlyhala (`ok =
 * false`). Presne to, čo majiteľ chcel vidieť namiesto AI: zoznam, podľa
 * ktorého sa dá rozhodnúť, pre koho sa oplatí dorobiť čítanie ručne.
 */
export async function listUnreadableHosts(db: Database): Promise<readonly UnreadableHost[]> {
  const rows = await db
    .select({ host: supplierStock.host, link: supplierStock.link, sizeLabel: supplierStock.sizeLabel })
    .from(supplierStock)
    .where(or(eq(supplierStock.ok, false), eq(supplierStock.availability, "unknown")))
    .orderBy(asc(supplierStock.host), asc(supplierStock.link), asc(supplierStock.sizeLabel));

  const byHost = new Map<string, UnreadableSample[]>();
  for (const row of rows) {
    const samples = byHost.get(row.host) ?? [];
    // Pri odkaze s pravidlom na veľkosti (issue 224) môže na tú istú linku
    // pripadnúť viac neprečítaných veľkostí naraz — každá je VLASTNÁ ukážka,
    // aby bolo vidno KTORÁ veľkosť sa neprečítala, nie len odkaz.
    samples.push({ link: row.link, sizeLabel: row.sizeLabel });
    byHost.set(row.host, samples);
  }
  return [...byHost.entries()]
    .map(([host, samples]) => ({ host, count: samples.length, samples: samples.slice(0, 5) }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
}

/** Najnovšie kontroly — malý zoznam pre hlavičku obrazovky. */
export async function listRecentChecks(db: Database, limit = 10): Promise<readonly SupplierStockRow[]> {
  return db
    .select({
      link: supplierStock.link,
      sizeLabel: supplierStock.sizeLabel,
      host: supplierStock.host,
      availability: supplierStock.availability,
      availabilityText: supplierStock.availabilityText,
      price: supplierStock.price,
      source: supplierStock.source,
      ok: supplierStock.ok,
      error: supplierStock.error,
      httpStatus: supplierStock.httpStatus,
      checkedAt: supplierStock.checkedAt,
      confirmedAt: supplierStock.confirmedAt,
    })
    .from(supplierStock)
    .orderBy(desc(supplierStock.checkedAt))
    .limit(limit);
}
