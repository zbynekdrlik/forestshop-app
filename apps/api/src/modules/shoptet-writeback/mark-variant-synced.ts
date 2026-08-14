import { and, inArray, lte } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairingVariantLinks } from "../../db/schema.js";

/**
 * Označí dané per-veľkosť linky (`pairing_variant_link.code`) ako úspešne
 * zapísané do Shoptetu — mirror `markSuppliersLinksSynced` (mark-synced.ts),
 * len na `pairing_variant_link.synced_at`. Volaj LEN po POTVRDENOM úspechu
 * (zlúčený linkový import prešiel, Log ukázal presne toľko spracovaných
 * riadkov, koľko sa poslalo, `run-writeback.ts`). Pri chybe/nejednoznačnom
 * výsledku ostáva `synced_at` nezmenené, takže nasledujúci beh tie isté
 * linky pošle znova. No-op pre prázdny zoznam.
 *
 * `now` je čas ZAČIATKU celého behu (rovnaký race guard ako linkový/stavový
 * zápis, `.claude/rules/shoptet-writeback.md`): keby sa link zmenil ZNOVA
 * MEDZI výberom a týmto zápisom (import cez prehliadač trvá desiatky sekúnd),
 * jeho nový `updated_at` je NUTNE neskôr než `now`, takže ho `updated_at <=
 * now` podmienka NEoznačí ako synchronizovaný a nasledujúci beh ho pošle
 * znova (do Shoptetu odišla len STARŠIA hodnota).
 */
export async function markVariantLinksSynced(db: Database, codes: readonly string[], now: Date): Promise<void> {
  if (codes.length === 0) return;
  await db
    .update(pairingVariantLinks)
    .set({ syncedAt: now })
    .where(and(inArray(pairingVariantLinks.code, [...codes]), lte(pairingVariantLinks.updatedAt, now)));
}
