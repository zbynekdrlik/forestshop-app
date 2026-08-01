import { inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { productSupplierLinkOverrides } from "../../db/schema.js";

/**
 * Označí dané `productKey`s ako úspešne zapísané do Shoptetu — voláme LEN po
 * POTVRDENOM úspechu (Log ukázal presne toľko spracovaných riadkov, koľko
 * sme poslali, žiadne zlyhania, `run-writeback.ts`). Nikdy inak: pri chybe/
 * nejednoznačnom výsledku ostáva `syncedAt` nezmenené, takže nasledujúci beh
 * tie isté produkty pošle znova. No-op pre prázdny zoznam (nič sa neposlalo).
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
    .where(inArray(productSupplierLinkOverrides.productKey, [...productKeys]));
}
