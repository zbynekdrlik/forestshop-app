import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairingDecisions, pairingVariantLinks, variants } from "../../db/schema.js";
import type { WritebackRow } from "./csv.js";

export interface SelectedVariantLinkWriteback {
  /** `code` of every per-size link actually included below — used to mark
   * `syncedAt` after a CONFIRMED successful import (run-writeback.ts). */
  readonly codes: readonly string[];
  /** one row per SPLIT-governed variant with a per-size link, ready to merge
   * into buildWritebackCsv (same `code;pairCode;internalNote` shape as the
   * product-level path). */
  readonly rows: readonly WritebackRow[];
}

/**
 * "Zmenilo sa niečo od posledného úspešného zápisu per-veľkosť liniek?"
 * (issue 423) — mirror `selectChangedSupplierLinks` (select-changes.ts), len
 * nad `pairing_variant_link` namiesto `product_supplier_link_override`.
 * `synced_at IS NULL` = ešte nikdy odoslané; `synced_at < updated_at` =
 * odoslané, ale link odvtedy znova zmenený (`variant-links.ts`'s
 * `setPairingVariantLink` obnovuje `updated_at` pri KAŽDEJ zmene).
 *
 * GATE `pairing_decision.status = 'split'` — presne starej appky's
 * `split_codes` gate (`webreview/app.py`'s `_do_upload_variant_links`): link
 * je "efektívny" LEN keď je produkt reálne ROZDELENÝ, nie len rozpísaný v
 * paneli, ešte nepotvrdený "✓ Hotovo". Dormantná per-veľkosť linka (produkt
 * nerozdelený / vrátený späť) sa do Shoptetu nikdy neposiela — jeho efektívna
 * linka je produktová (`select-changes.ts`).
 *
 * `pairing_variant_link.code` je FK na `variant.code` (cascade), takže
 * `innerJoin variants` NIKDY nič nestratí — na rozdiel od
 * `selectChangedSupplierLinks`/`selectChangedStateDecisions` tu nie je
 * "anomália bez variantu" (link bez variantu je štrukturálne nemožný).
 */
export async function selectChangedVariantLinks(db: Database): Promise<SelectedVariantLinkWriteback> {
  const rows = await db
    .select({
      code: pairingVariantLinks.code,
      pairCode: variants.pairCode,
      url: pairingVariantLinks.url,
    })
    .from(pairingVariantLinks)
    .innerJoin(variants, eq(variants.code, pairingVariantLinks.code))
    .innerJoin(pairingDecisions, eq(pairingDecisions.productKey, variants.productKey))
    .where(
      and(
        or(isNull(pairingVariantLinks.syncedAt), lt(pairingVariantLinks.syncedAt, pairingVariantLinks.updatedAt)),
        eq(pairingDecisions.status, "split"),
        // issue 465: rovnaká diera ako v `select-changes.ts` — per-veľkosť link
        // pre variant, ktorý zmizol zo Shoptetu (`missing_since`), sa nikdy
        // neposiela (Shoptet by odmietol celú dávku pre neexistujúci kód). Kód
        // sa neoznačí ako synced (nie je v `rows`), ale ani nič neotrávi (0
        // riadkov); ak sa variant vráti (catalog import vymaže `missing_since`),
        // sám sa znova vyberie a zapíše — self-heal, netreba marking-set ako pri
        // produktovej ceste.
        isNull(variants.missingSince),
      ),
    )
    .orderBy(pairingVariantLinks.code);

  return {
    codes: rows.map((r) => r.code),
    rows: rows.map((r) => ({ code: r.code, pairCode: r.pairCode ?? "", internalNote: r.url })),
  };
}
