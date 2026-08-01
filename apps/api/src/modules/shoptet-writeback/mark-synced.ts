import { and, inArray, lte } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { productSupplierLinkOverrides } from "../../db/schema.js";

/**
 * Označí dané `productKey`s ako úspešne zapísané do Shoptetu — voláme LEN po
 * POTVRDENOM úspechu (Log ukázal presne toľko spracovaných riadkov, koľko
 * sme poslali, žiadne zlyhania, `run-writeback.ts`). Nikdy inak: pri chybe/
 * nejednoznačnom výsledku ostáva `syncedAt` nezmenené, takže nasledujúci beh
 * tie isté produkty pošle znova. No-op pre prázdny zoznam (nič sa neposlalo).
 *
 * `now` je časový moment ZAČIATKU celého behu (`run-writeback.ts` ho dostáva
 * ako parameter od schedulera, PRED `selectChangedSupplierLinks` aj PRED
 * (potenciálne dlho bežiacim) Playwright importom) — `updatedAt <= now`
 * podmienka chráni pred pretekaním: keby majiteľ upravil TEN ISTÝ odkaz
 * ZNOVA niekedy MEDZI výberom riadkov a týmto zápisom (celý beh môže trvať
 * desiatky sekúnd kvôli prehliadaču), tá novšia úprava má `updatedAt` NUTNE
 * neskôr než `now` (mohla nastať len po štarte behu) — takto sa NEoznačí
 * ako synchronizovaná, hoci do Shoptetu odišla len jej STARŠIA hodnota;
 * nasledujúci beh ju pošle znova.
 */
export async function markSuppliersLinksSynced(
  db: Database,
  productKeys: readonly string[],
  now: Date,
): Promise<void> {
  if (productKeys.length === 0) return;
  await db
    .update(productSupplierLinkOverrides)
    .set({ syncedAt: now })
    .where(
      and(
        inArray(productSupplierLinkOverrides.productKey, [...productKeys]),
        lte(productSupplierLinkOverrides.updatedAt, now),
      ),
    );
}
