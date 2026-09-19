// issue 432/571 — katalógové pokrytie linkami + rollup stavu produktu.
// Vyčlenené z `queries.ts` (issue 571), aby ani jeden súbor nenarástol cez
// eslint `max-lines: 400` (`.claude/rules/testing.md`'s zavedený vzor). Číra
// pomocná vrstva bez vlastného endpointu/tabuľky — `queries.ts` je jediný
// konzument (`listPairingReview` volá `computeCatalogCoverage`,
// `buildPairingReviewItems` volá `rollupProductState`).

import { inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairingDecisions, productSupplierLinkOverrides, products, variants } from "../../db/schema.js";
import { resolveEffectiveSupplierLink } from "../orders/effective-supplier-link.js";
import { SELLABLE_VISIBILITY } from "../restock/constants.js";
import type { PairingReviewProductState } from "./queries.js";

/** Minimálny tvar variantu, ktorý `rollupProductState` číta — `VariantRow`
 * (`queries.ts`) je štruktúrne kompatibilný (má tieto polia + ďalšie). */
export interface RollupVariant {
  readonly state: PairingReviewProductState;
  readonly productVisibility: string;
  readonly missingSince: Date | null;
}

/** Nejaký variant `sellable` → Skladom; inak nejaký `out_of_stock` a VIDITEĽNÝ
 * (rovnaká podmienka ako `pairing-search/select.ts`'s `soldOutVisible`) →
 * Nie je skladom; inak → Už sa nebude predávať. `detailOnly` samo osebe nie
 * je "vypnuté" (`.claude/rules/catalog.md`'s `availability.ts` pravidlo) —
 * zachytené tým, že len `out_of_stock` + `SELLABLE_VISIBILITY` počíta ako
 * "Nie je skladom", nikdy len `out_of_stock`. Produkt bez VARIANTOV vôbec
 * (teoreticky nemožné — katalógový import ich vždy páruje) padá na "Už sa
 * nebude predávať", nikdy nevyhodí. */
export function rollupProductState(rows: readonly RollupVariant[]): PairingReviewProductState {
  if (rows.some((r) => r.state === "sellable")) return "sellable";
  if (rows.some((r) => r.state === "out_of_stock" && r.productVisibility === SELLABLE_VISIBILITY && r.missingSince === null)) {
    return "out_of_stock";
  }
  return "discontinued";
}

// issue 432 — SKUTOČNÉ katalógové pokrytie linkami. NA ROZDIEL od
// `gatheredTotal`/`linkedTotal` (veľkosť recenznej FRONTY = únia gatherované ∪
// bez-linky ∪ rozhodnuté) toto meria KATALÓG. issue 571 — „aktívny produkt" =
// `rollupProductState(varianty)` ∈ {`sellable`, `out_of_stock`} (nie ukončený),
// TÁ ISTÁ funkcia ako filter/karta, žiadny druhý predikát — predtým to bolo len
// „aspoň jeden sellable variant", čo míňalo vypredané produkty (len viditeľný
// `out_of_stock`), ktoré job restock prepína a majiteľ ich chce v menovateli.
// `catalogLinked` = koľko z aktívnych má EFEKTÍVNU dodávateľskú linku
// (`resolveEffectiveSupplierLink` = override ∪ `internalNote` extrakcia — TÁ
// ISTÁ čítacia logika, žiadny duplicitný regex). `catalogMissing` =
// `catalogActive − catalogLinked` (horný ukazovateľ „chýba K", rovná sa `total`
// filtra `unreviewed`). Rovnaký MVP „načítaj celý katalóg do JS" vzor ako
// `determineReviewPopulationKeys`. Počíta sa NEZÁVISLE od populácie fronty —
// aktívny olinkovaný produkt MIMO populácie (má linku, nebol gatherovaný ani
// rozhodnutý) sa v pokrytí správne objaví, hoci `linkedTotal` (odvodený z
// fronty) ho minie.
export async function computeCatalogCoverage(
  db: Database,
): Promise<{ readonly catalogActive: number; readonly catalogLinked: number; readonly catalogMissing: number; readonly activeUnpaired: number }> {
  // Aktívne kľúče cez `rollupProductState` (potrebuje state+visibility+missingSince
  // na variant) — jeden prechod cez varianty, zoskupenie po produkte.
  const rollupRows = await db
    .select({ productKey: variants.productKey, state: variants.state, productVisibility: variants.productVisibility, missingSince: variants.missingSince })
    .from(variants);
  const variantsByProduct = new Map<string, (typeof rollupRows)[number][]>();
  for (const row of rollupRows) {
    const bucket = variantsByProduct.get(row.productKey);
    if (bucket === undefined) variantsByProduct.set(row.productKey, [row]);
    else bucket.push(row);
  }
  const activeKeys: string[] = [];
  for (const [key, rows] of variantsByProduct) {
    const st = rollupProductState(rows);
    if (st === "sellable" || st === "out_of_stock") activeKeys.push(key);
  }
  if (activeKeys.length === 0) return { catalogActive: 0, catalogLinked: 0, catalogMissing: 0, activeUnpaired: 0 };

  const productRows = await db.select({ key: products.key, internalNote: products.internalNote }).from(products).where(inArray(products.key, activeKeys));
  const internalNoteByKey = new Map(productRows.map((r) => [r.key, r.internalNote]));

  const overrideRows = await db
    .select({ productKey: productSupplierLinkOverrides.productKey, url: productSupplierLinkOverrides.url })
    .from(productSupplierLinkOverrides)
    .where(inArray(productSupplierLinkOverrides.productKey, activeKeys));
  const overrideByProduct = new Map(overrideRows.map((r) => [r.productKey, r.url]));

  // issue 446 — badge záložky Párovanie = AKTÍVNE nenapárované produkty
  // (aktívny AND bez efektívneho odkazu AND bez TERMINÁLNEHO rozhodnutia).
  // Terminálne rozhodnutie (unavailable/discontinued/split — tá istá množina
  // ako `isUnreviewed` v `queries.ts`) znamená "už zrevidované, netreba naň
  // upozorňovať". `good`/`manual` VŽDY produkujú efektívnu linku, takže sú
  // vylúčené už podmienkou `effective.url !== null`. Počíta sa v tom istom
  // prechode ako `catalogLinked`, aby si badge a hlavný ukazovateľ obrazovky
  // (catalogActive − catalogLinked) nemohli rozísť.
  const terminalDecisionRows = await db
    .select({ productKey: pairingDecisions.productKey, status: pairingDecisions.status })
    .from(pairingDecisions)
    .where(inArray(pairingDecisions.productKey, activeKeys));
  const terminalDecided = new Set(
    terminalDecisionRows
      .filter((r) => r.status === "unavailable" || r.status === "discontinued" || r.status === "split")
      .map((r) => r.productKey),
  );

  let catalogLinked = 0;
  let activeUnpaired = 0;
  for (const key of activeKeys) {
    const effective = resolveEffectiveSupplierLink(internalNoteByKey.get(key) ?? null, overrideByProduct.get(key) ?? null);
    if (effective.url !== null) {
      catalogLinked += 1;
      continue;
    }
    if (!terminalDecided.has(key)) activeUnpaired += 1;
  }
  return { catalogActive: activeKeys.length, catalogLinked, catalogMissing: activeKeys.length - catalogLinked, activeUnpaired };
}
