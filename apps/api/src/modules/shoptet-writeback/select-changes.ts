import { eq, isNull, lt, or } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { productSupplierLinkOverrides, variants } from "../../db/schema.js";
import { log } from "../../logger.js";
import type { WritebackRow } from "./csv.js";

export interface SelectedWriteback {
  /** productKey of every override actually included below — used to mark
   * `syncedAt` after a CONFIRMED successful import (run-writeback.ts). */
  readonly productKeys: readonly string[];
  /** one row per variant of every changed product, ready for buildWritebackCsv. */
  readonly rows: readonly WritebackRow[];
}

/**
 * "Zmenilo sa niečo od posledného úspešného zápisu?" (issue 122) — nikdy
 * celý katalóg. `syncedAt IS NULL` = ešte nikdy odoslané; `syncedAt <
 * updatedAt` = odoslané, ale odvtedy znova upravené (ďalšia úprava po
 * predchádzajúcom syncu). Vracia jeden CSV riadok PER VARIANT patriaci
 * danému produktu — `internalNote` (odkaz na dodávateľa) je produktové pole,
 * ale Shoptet páruje import podľa variantového `code`+`pairCode`
 * (`parovanie_produktov`'s `link_rows`, viď design komentár na #122).
 */
export async function selectChangedSupplierLinks(db: Database): Promise<SelectedWriteback> {
  const changedCondition = or(
    isNull(productSupplierLinkOverrides.syncedAt),
    lt(productSupplierLinkOverrides.syncedAt, productSupplierLinkOverrides.updatedAt),
  );

  const rows = await db
    .select({
      code: variants.code,
      pairCode: variants.pairCode,
      internalNote: productSupplierLinkOverrides.url,
      productKey: productSupplierLinkOverrides.productKey,
    })
    .from(productSupplierLinkOverrides)
    .innerJoin(variants, eq(variants.productKey, productSupplierLinkOverrides.productKey))
    .where(changedCondition);

  const productKeys = [...new Set(rows.map((r) => r.productKey))];

  // review of PR 140: an override for a productKey with ZERO variant rows
  // (a data anomaly — every real product has at least one variant) would
  // otherwise silently drop out of the innerJoin above forever, never
  // synced and never logged. Making the gap OBSERVABLE (rather than a
  // permanently silent no-op) is cheap — one extra id-only query, only run
  // when there is anything changed at all to compare against.
  const changedOverrides = await db
    .select({ productKey: productSupplierLinkOverrides.productKey })
    .from(productSupplierLinkOverrides)
    .where(changedCondition);
  const skipped = changedOverrides.map((o) => o.productKey).filter((key) => !productKeys.includes(key));
  if (skipped.length > 0) {
    log.warn(
      { skippedProductKeys: skipped },
      "shoptet write-back: preskočené zmenené odkazy na dodávateľa bez žiadneho variantu (dátová anomália)",
    );
  }

  return {
    productKeys,
    rows: rows.map((r) => ({ code: r.code, pairCode: r.pairCode ?? "", internalNote: r.internalNote })),
  };
}
