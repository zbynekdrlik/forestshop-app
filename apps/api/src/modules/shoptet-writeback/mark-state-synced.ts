import { and, inArray, lte } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairingDecisions } from "../../db/schema.js";

/**
 * Označí dané `productKey`s ako stavovo úspešne zapísané do Shoptetu — mirror
 * `markSuppliersLinksSynced` (mark-synced.ts), len na `pairing_decision
 * .state_synced_at`. Volaj LEN po POTVRDENOM úspechu stavového importu
 * (Log ukázal presne toľko spracovaných riadkov, koľko sa poslalo, žiadne
 * zlyhania, `run-state-writeback.ts`). `now` je čas ZAČIATKU celého behu
 * (rovnaký race guard ako linkový zápis, `.claude/rules/shoptet-writeback
 * .md`): keby sa rozhodnutie zmenilo znova MEDZI výberom a týmto zápisom
 * (import cez prehliadač môže trvať desiatky sekúnd), `updated_at <= now`
 * podmienka to rozpozná (nová hodnota má `updated_at` nutne neskôr než
 * `now`) a NEoznačí ju ako synchronizovanú — nasledujúci beh ju pošle znova.
 */
export async function markStateSynced(db: Database, productKeys: readonly string[], now: Date): Promise<void> {
  if (productKeys.length === 0) return;
  await db
    .update(pairingDecisions)
    .set({ stateSyncedAt: now })
    .where(and(inArray(pairingDecisions.productKey, [...productKeys]), lte(pairingDecisions.updatedAt, now)));
}
