import type { Database } from "../../db/client.js";
import { buildWritebackCsv, dedupeWritebackRowsByCode } from "./csv.js";
import type { ShoptetImportConfig } from "./config.js";
import { markSuppliersLinksSynced } from "./mark-synced.js";
import { markVariantLinksSynced } from "./mark-variant-synced.js";
import { runShoptetImportIsolated, type ShoptetImportOutcome } from "./playwright-import.js";
import { selectChangedSupplierLinks } from "./select-changes.js";
import { selectChangedVariantLinks } from "./select-variant-links.js";

export type WritebackRunResult =
  | { readonly status: "nothing_changed" }
  | { readonly status: "ok"; readonly productCount: number; readonly variantLinkCount: number; readonly rowCount: number }
  | {
      readonly status: "failed";
      readonly productCount: number;
      readonly variantLinkCount: number;
      readonly rowCount: number;
      readonly processed: number | null;
      readonly failed: number | null;
      readonly errorDetail: string | null;
    };

/**
 * Celý beh issue 122 + issue 423: vyber zmenené PRODUKTOVÉ odkazy
 * (`select-changes.ts`, split-riadené varianty vylúčené) A zmenené
 * PER-VEĽKOSŤ split linky (`select-variant-links.ts`, LEN split-riadené) →
 * ZLÚČ do JEDNÉHO CSV (identické stĺpce `code;pairCode;internalNote`,
 * disjunktné po kóde) → nahraj cez JEDEN Playwright import → LEN po
 * POTVRDENOM úspechu označ OBE strany ako synchronizované. Žiadny druhý
 * browser child-proces navyše, žiadny nový Štart/Stop prepínač (linkový
 * zápis mení len privátnu poznámku, nie viditeľnosť — rovnaké zdôvodnenie
 * ako #122). Pri chybe/nejednoznačnom výsledku sa `syncedAt` ani na jednej
 * strane NIKDY nezmení — nasledujúci beh (naplánovaná úloha,
 * `scheduler/jobs.ts`) tie isté položky pošle znova. `now` sa berie ako
 * parameter (nie `new Date()` tu vnútri), rovnaká disciplína ako
 * `catalogImportJob`/`ordersImportJob`.
 *
 * Per-veľkosť riadky idú do zlúčenia PRVÉ, aby pri (konštrukčne nemožnom)
 * strete kódu vyhral konkrétnejší per-veľkosť link, nie produktový override.
 *
 * issue 387 E7 (review nález): `runShoptetImportIsolated` VYHADZUJE (nie len
 * vracia `{ok:false}`) na TVRDOM zlyhaní — TENTO `try`/`catch` PREMIEŇA aj
 * tento prípad na normálny `{status:"failed"}` výsledok, aby výnimka nikdy
 * neprešla do `run-writeback-sequence.ts` a nezastavila DRUHÝ (stavový)
 * import.
 */
export async function runShoptetWriteback(
  db: Database,
  config: ShoptetImportConfig,
  now: Date,
): Promise<WritebackRunResult> {
  const product = await selectChangedSupplierLinks(db);
  const variant = await selectChangedVariantLinks(db);
  const rows = dedupeWritebackRowsByCode([...variant.rows, ...product.rows]);
  if (rows.length === 0) {
    // Žiadny CSV na nahranie — ALE fully-split produkt (override zmenený,
    // VŠETKY varianty split-riadené) je v `product.productKeys` s 0 riadkami:
    // jeho override je dormantný (nič sa preň neposiela, per-veľkosť linky ho
    // pokrývajú) → musí sa označiť synced TERAZ, inak by re-selectoval každý
    // hodinový beh donekonečna (invariant dokumentovaný v `select-changes.ts`).
    // `variant.codes` je pri 0 riadkoch prázdny (no-op). Žiadny Shoptet import
    // sa nedeje ani nepreskakuje — pre dormantný override niet čo poslať;
    // `updated_at <= now` guard (`mark-synced.ts`) drží race ochranu.
    await markSuppliersLinksSynced(db, product.productKeys, now);
    return { status: "nothing_changed" };
  }

  const csv = buildWritebackCsv(rows);
  let outcome: ShoptetImportOutcome;
  try {
    outcome = await runShoptetImportIsolated({ config, csv, expectedRows: rows.length });
  } catch (error) {
    return {
      status: "failed",
      productCount: product.productKeys.length,
      variantLinkCount: variant.codes.length,
      rowCount: rows.length,
      processed: null,
      failed: null,
      errorDetail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!outcome.ok) {
    return {
      status: "failed",
      productCount: product.productKeys.length,
      variantLinkCount: variant.codes.length,
      rowCount: rows.length,
      processed: outcome.processed,
      failed: outcome.failed,
      errorDetail: outcome.errorDetail,
    };
  }

  await markSuppliersLinksSynced(db, product.productKeys, now);
  await markVariantLinksSynced(db, variant.codes, now);
  return { status: "ok", productCount: product.productKeys.length, variantLinkCount: variant.codes.length, rowCount: rows.length };
}
