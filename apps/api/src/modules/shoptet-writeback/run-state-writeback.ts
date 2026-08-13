import type { Database } from "../../db/client.js";
import { buildStatesCsv, dedupeStateRowsByCode } from "./csv.js";
import type { ShoptetImportConfig } from "./config.js";
import { markStateSynced } from "./mark-state-synced.js";
import { runShoptetImportIsolated, type ShoptetImportOutcome } from "./playwright-import.js";
import { selectChangedStateDecisions } from "./select-states.js";

export type StateWritebackRunResult =
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
 * issue 387 E7 — DRUHÝ, SAMOSTATNÝ writeback beh (mirror `runShoptetWriteback`,
 * run-writeback.ts): vyber terminálne rozhodnutia (unavailable/discontinued)
 * bez čerstvého stavového syncu → postav stavový CSV → nahraj cez Playwright
 * (ŽIADEN nový Playwright kód — ten istý `runShoptetImportIsolated`, teda
 * aj tá istá `ensureSafeSettings` read-back kontrola) → LEN po POTVRDENOM
 * úspechu označ dané produkty ako stavovo synchronizované. Pri chybe/
 * nejednoznačnom výsledku sa `stateSyncedAt` NIKDY nezmení — nasledujúci
 * beh (`shoptetWritebackJob`, cez `run-writeback-sequence.ts`) tie isté
 * produkty pošle znova.
 *
 * Review nález (rovnaký ako `run-writeback.ts`): `runShoptetImportIsolated`
 * VYHADZUJE na tvrdom zlyhaní (nie len `{ok:false}`) — `try`/`catch` nižšie
 * to premieňa na normálny `{status:"failed"}` výsledok, aby výnimka NIKDY
 * neprešla do `run-writeback-sequence.ts` a nezastavila (v opačnom poradí
 * volania) linkový podbeh.
 */
export async function runShoptetStateWriteback(
  db: Database,
  config: ShoptetImportConfig,
  now: Date,
): Promise<StateWritebackRunResult> {
  const { productKeys, rows } = await selectChangedStateDecisions(db);
  if (rows.length === 0) return { status: "nothing_changed" };

  // `dedupeStateRowsByCode` sa volá TU (nie len vnútri `buildStatesCsv`),
  // aby `expectedRows` (Log-overenie výsledku importu, `log-attribution.ts`)
  // sedelo s tým, čo `buildStatesCsv` skutočne zapíše — jeden zdroj pravdy.
  const deduped = dedupeStateRowsByCode(rows);
  const csv = buildStatesCsv(rows);
  let outcome: ShoptetImportOutcome;
  try {
    outcome = await runShoptetImportIsolated({ config, csv, expectedRows: deduped.length });
  } catch (error) {
    return {
      status: "failed",
      productCount: productKeys.length,
      rowCount: deduped.length,
      processed: null,
      failed: null,
      errorDetail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!outcome.ok) {
    return {
      status: "failed",
      productCount: productKeys.length,
      rowCount: deduped.length,
      processed: outcome.processed,
      failed: outcome.failed,
      errorDetail: outcome.errorDetail,
    };
  }

  await markStateSynced(db, productKeys, now);
  return { status: "ok", productCount: productKeys.length, rowCount: deduped.length };
}
