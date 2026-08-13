import type { Database } from "../../db/client.js";
import { buildWritebackCsv } from "./csv.js";
import type { ShoptetImportConfig } from "./config.js";
import { markSuppliersLinksSynced } from "./mark-synced.js";
import { runShoptetImportIsolated, type ShoptetImportOutcome } from "./playwright-import.js";
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
 *
 * issue 387 E7 (review nález): `runShoptetImportIsolated` VYHADZUJE (nie len
 * vracia `{ok:false}`) na TVRDOM zlyhaní (nenájde prihlasovací formulár,
 * nenájde bezpečný radio, dieťa proces skončí bez výsledku — `child-
 * runner.ts`) — TENTO `try`/`catch` PREMIEŇA aj tento prípad na normálny
 * `{status:"failed"}` výsledok (`processed`/`failed` `null`, keďže žiadny
 * štruktúrovaný Log výsledok nebol získaný). Bez neho by výnimka prešla AŽ
 * DO `run-writeback-sequence.ts`, kde by ZASTAVILA aj pokus o DRUHÝ
 * (stavový) import — presne opak toho, čo `runShoptetWritebackSequence`
 * sľubuje ("nezávislé"). Predtým sa toto nikdy neprejavilo, lebo `run-
 * writeback.ts` bolo JEDINÝM krokom behu (issue 122) — teraz je PRVÝM z DVOCH.
 */
export async function runShoptetWriteback(
  db: Database,
  config: ShoptetImportConfig,
  now: Date,
): Promise<WritebackRunResult> {
  const { productKeys, rows } = await selectChangedSupplierLinks(db);
  if (rows.length === 0) return { status: "nothing_changed" };

  const csv = buildWritebackCsv(rows);
  let outcome: ShoptetImportOutcome;
  try {
    outcome = await runShoptetImportIsolated({ config, csv, expectedRows: rows.length });
  } catch (error) {
    return {
      status: "failed",
      productCount: productKeys.length,
      rowCount: rows.length,
      processed: null,
      failed: null,
      errorDetail: error instanceof Error ? error.message : String(error),
    };
  }

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
