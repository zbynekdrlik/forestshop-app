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
  readonly host: string;
  readonly availability: "available" | "unavailable" | "unknown";
  readonly availabilityText: string;
  readonly price: string | null;
  readonly source: "json_ld" | "meta" | "text" | "none";
  readonly ok: boolean;
  readonly error: string | null;
  readonly httpStatus: number | null;
  readonly checkedAt: Date;
  readonly confirmedAt: Date | null;
}

/** Jeden riadok na doménu, ktorú sa nedarí čítať — karta pre majiteľa. */
export interface UnreadableHost {
  readonly host: string;
  readonly count: number;
  /** Ukážkové linky (max 5), aby sa dalo hneď kliknúť a pozrieť sa. */
  readonly samples: readonly string[];
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
    .orderBy(asc(supplierStock.host), asc(supplierStock.link))
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
    .select({ host: supplierStock.host, link: supplierStock.link })
    .from(supplierStock)
    .where(or(eq(supplierStock.ok, false), eq(supplierStock.availability, "unknown")))
    .orderBy(asc(supplierStock.host), asc(supplierStock.link));

  const byHost = new Map<string, string[]>();
  for (const row of rows) {
    const links = byHost.get(row.host) ?? [];
    links.push(row.link);
    byHost.set(row.host, links);
  }
  return [...byHost.entries()]
    .map(([host, links]) => ({ host, count: links.length, samples: links.slice(0, 5) }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
}

/** Najnovšie kontroly — malý zoznam pre hlavičku obrazovky. */
export async function listRecentChecks(db: Database, limit = 10): Promise<readonly SupplierStockRow[]> {
  return db
    .select({
      link: supplierStock.link,
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
