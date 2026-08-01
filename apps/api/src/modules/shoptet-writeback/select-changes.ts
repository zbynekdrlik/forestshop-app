import { eq, isNull, lt, or } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { productSupplierLinkOverrides, variants } from "../../db/schema.js";
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
  const rows = await db
    .select({
      code: variants.code,
      pairCode: variants.pairCode,
      internalNote: productSupplierLinkOverrides.url,
      productKey: productSupplierLinkOverrides.productKey,
    })
    .from(productSupplierLinkOverrides)
    .innerJoin(variants, eq(variants.productKey, productSupplierLinkOverrides.productKey))
    .where(
      or(
        isNull(productSupplierLinkOverrides.syncedAt),
        lt(productSupplierLinkOverrides.syncedAt, productSupplierLinkOverrides.updatedAt),
      ),
    );

  const productKeys = [...new Set(rows.map((r) => r.productKey))];
  return {
    productKeys,
    rows: rows.map((r) => ({ code: r.code, pairCode: r.pairCode ?? "", internalNote: r.internalNote })),
  };
}
