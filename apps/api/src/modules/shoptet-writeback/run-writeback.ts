import type { Database } from "../../db/client.js";
import { buildWritebackCsv } from "./csv.js";
import type { ShoptetImportConfig } from "./config.js";
import { markSuppliersLinksSynced } from "./mark-synced.js";
import { runShoptetImport } from "./playwright-import.js";
import { selectChangedSupplierLinks } from "./select-changes.js";

export type WritebackRunResult =
  | { readonly status: "nothing_changed" }
  | { readonly status: "ok"; readonly productCount: number; readonly rowCount: number }
  | {
      readonly status: "failed";
      readonly productCount: number;
      readonly rowCount: number;
      readonly processed: number | null;
      readonly failed: number | null;
      readonly errorDetail: string | null;
    };

/**
 * Celý beh issue 122: vyber zmenené odkazy → postav CSV → nahraj cez
 * Playwright → LEN po POTVRDENOM úspechu označ dané produkty ako
 * synchronizované. Pri chybe/nejednoznačnom výsledku sa `syncedAt` NIKDY
 * nezmení — nasledujúci beh (naplánovaná úloha, `scheduler/jobs.ts`) tie isté
 * produkty pošle znova. `now` sa berie ako parameter (nie `new Date()` tu
 * vnútri), rovnaká disciplína ako `catalogImportJob`/`ordersImportJob`.
 */
export async function runShoptetWriteback(
  db: Database,
  config: ShoptetImportConfig,
  now: Date,
): Promise<WritebackRunResult> {
  const { productKeys, rows } = await selectChangedSupplierLinks(db);
  if (rows.length === 0) return { status: "nothing_changed" };

  const csv = buildWritebackCsv(rows);
  const outcome = await runShoptetImport({ config, csv, expectedRows: rows.length });

  if (!outcome.ok) {
    return {
      status: "failed",
      productCount: productKeys.length,
      rowCount: rows.length,
      processed: outcome.processed,
      failed: outcome.failed,
      errorDetail: outcome.errorDetail,
    };
  }

  await markSuppliersLinksSynced(db, productKeys, now);
  return { status: "ok", productCount: productKeys.length, rowCount: rows.length };
}
