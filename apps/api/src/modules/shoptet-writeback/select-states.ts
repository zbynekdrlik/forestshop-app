import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairingDecisions, variants } from "../../db/schema.js";
import { log } from "../../logger.js";
import type { StateCsvRow, StateWritebackStatus } from "./csv.js";

export interface SelectedStateWriteback {
  /** productKey of every decision actually included below — used to mark
   * `stateSyncedAt` after a CONFIRMED successful import (run-state-writeback.ts). */
  readonly productKeys: readonly string[];
  /** one row per variant of every changed decision, ready for buildStatesCsv. */
  readonly rows: readonly StateCsvRow[];
}

/**
 * "Zmenilo sa niečo od posledného úspešného stavového zápisu?" (issue 387 E7)
 * — mirror `selectChangedSupplierLinks` (select-changes.ts), len nad
 * `pairing_decision` namiesto `product_supplier_link_override`.
 * `state_synced_at IS NULL` = ešte nikdy odoslané; `state_synced_at <
 * updated_at` = odoslané, ale odvtedy rozhodnutie znova zmenené
 * (`pairing-review/decisions.ts`'s `upsertPairingDecisionRow` nuluje
 * `state_synced_at` pri KAŽDEJ zmene). LEN terminálne rozhodnutia
 * (unavailable/discontinued) — `good`/`manual` nikdy stavovú CSV riadok
 * nedostanú (idú cez existujúci `internalNote` zápis, issue 122).
 */
export async function selectChangedStateDecisions(db: Database): Promise<SelectedStateWriteback> {
  const changedCondition = and(
    inArray(pairingDecisions.status, ["unavailable", "discontinued"]),
    or(isNull(pairingDecisions.stateSyncedAt), lt(pairingDecisions.stateSyncedAt, pairingDecisions.updatedAt)),
  );

  const rows = await db
    .select({
      code: variants.code,
      pairCode: variants.pairCode,
      status: pairingDecisions.status,
      productKey: pairingDecisions.productKey,
    })
    .from(pairingDecisions)
    .innerJoin(variants, eq(variants.productKey, pairingDecisions.productKey))
    .where(changedCondition)
    .orderBy(variants.code);

  const productKeys = [...new Set(rows.map((r) => r.productKey))];

  // rovnaký "anomália bez variantu" pozorovací log ako
  // `selectChangedSupplierLinks` (select-changes.ts, review of PR 140) —
  // produkt bez variantov je dátová anomália, nikdy normálny prípad.
  const changedDecisions = await db
    .select({ productKey: pairingDecisions.productKey })
    .from(pairingDecisions)
    .where(changedCondition);
  const skipped = changedDecisions.map((d) => d.productKey).filter((key) => !productKeys.includes(key));
  if (skipped.length > 0) {
    log.warn(
      { skippedProductKeys: skipped },
      "shoptet stavový zápis: preskočené zmenené rozhodnutia bez žiadneho variantu (dátová anomália)",
    );
  }

  return {
    productKeys,
    // `changedCondition`'s `inArray(status, ["unavailable","discontinued"])`
    // zaručuje toto zúženie za behu — TS to sám odvodiť nevie (stĺpec je
    // celý `pairing_decision_status` enum).
    rows: rows.map((r) => ({ code: r.code, pairCode: r.pairCode ?? "", status: r.status as StateWritebackStatus })),
  };
}
