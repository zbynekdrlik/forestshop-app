// Zber dodávateľských odkazov a NAŠICH veľkostí pre nočný beh dodávateľského
// skladu — vyčlenené z `run.ts` (issue 585, eslint `max-lines: 400`). Obe
// funkcie kľúčujú cez EFEKTÍVNY odkaz (`resolveEffectiveSupplierLink`:
// override ∪ `internalNote`) — ten istý kľúč, aký číta `restock/queries.ts`
// (`effectiveSupplierLinkSql`). Rozchod kľúčov = plošný riadok zo štítku pri
// cene a prepnutie veľkostí, ktoré dodávateľ nemá (issue 585 code review).

import { eq, isNotNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairingDecisions, pairingVariantLinks, productSupplierLinkOverrides, products, variants } from "../../db/schema.js";
import { extractSupplierLink } from "../catalog/supplier-link.js";
import { resolveEffectiveSupplierLink } from "../orders/effective-supplier-link.js";
import { OWN_SHOP_HOST } from "./constants.js";
import { hostOf } from "./parse.js";

/** `product_key` → ručný odkaz z Párovania/Vyhľadať (`product_supplier_link_override`). */
async function loadOverrideMap(db: Database): Promise<Map<string, string>> {
  const rows = await db
    .select({ productKey: productSupplierLinkOverrides.productKey, url: productSupplierLinkOverrides.url })
    .from(productSupplierLinkOverrides);
  return new Map(rows.map((r) => [r.productKey, r.url]));
}

/** `true`, keď host (alebo jeho poddoména) patrí NÁŠMU VLASTNÉMU e-shopu —
 * také odkazy nie sú dodávateľ, nikdy sa nescrapujú (issue 227). */
function isOwnShopHost(host: string): boolean {
  return host === OWN_SHOP_HOST || host.endsWith(`.${OWN_SHOP_HOST}`);
}

/** Unikátne dodávateľské linky z katalógu, v stabilnom poradí. Odkazy na NÁŠ
 * VLASTNÝ e-shop (issue 227 — omylom vytiahnuté z `internalNote` tým istým
 * regexom ako skutočné odkazy) sa sem nikdy nedostanú.
 *
 * issue 423: navyše split-riadené per-veľkosť linky (`pairing_variant_link`
 * pre variant produktu s `pairing_decision.status='split'`). Split produkt
 * NEMÁ produktovú `internalNote` linku (jeho linky žijú per veľkosť), takže
 * bez tohto by sa jeho veľkosti nikdy nescrapovali. Každá split linka je
 * jedna URL na jednu veľkosť (jednoveľkostná stránka), takže sa scrapne ako
 * blanket (`size_label=''`, `collectOurSizesByLink` ju per-produkt grouping
 * NEZAHRNIE) a `restock/queries.ts`'s JOIN ju cez `size_label=''` vetvu
 * spáruje. Rovnaká `extractSupplierLink` normalizácia + vylúčenie vlastného
 * e-shopu ako pri produktových linkách, aby sa kľúč na `supplier_stock`
 * nemohol rozísť s `restock/queries.ts`. */
export async function collectSupplierLinks(db: Database): Promise<readonly string[]> {
  // issue 448: EFEKTÍVNY odkaz = override ∪ internalNote (`resolveEffectiveSupplierLink`,
  // TÁ ISTÁ čítacia logika ako ostatné čítacie cesty — orders, nedostupne,
  // pairing-review, product-links, coverage…). Potvrdený odkaz z Párovania
  // zapísaný do `product_supplier_link_override` tak tečie do nočného zberu
  // OKAMŽITE, bez čakania na Shoptet writeback + ďalší catalog sync. Čítame
  // VŠETKY produkty (bez `.where(isNotNull(internalNote))`) — produkt s override
  // ale bez poznámky by sa inak minul. Efektívna linka je čistá JS funkcia
  // (regex + coalesce), nedá sa vyjadriť ako SQL predikát bez duplicity —
  // rovnaký "načítaj do JS" vzor ako `computeCatalogCoverage`/
  // `determineReviewPopulationKeys` (`pairing-review/queries.ts`).
  const rows = await db.select({ key: products.key, internalNote: products.internalNote }).from(products);
  const overrideByProduct = await loadOverrideMap(db);
  const links = new Set<string>();
  for (const row of rows) {
    const url = resolveEffectiveSupplierLink(row.internalNote, overrideByProduct.get(row.key) ?? null).url;
    const host = url === null ? "" : hostOf(url);
    if (url !== null && host !== "" && !isOwnShopHost(host)) links.add(url);
  }

  const variantLinkRows = await db
    .select({ url: pairingVariantLinks.url })
    .from(pairingVariantLinks)
    .innerJoin(variants, eq(variants.code, pairingVariantLinks.code))
    .innerJoin(pairingDecisions, eq(pairingDecisions.productKey, variants.productKey))
    .where(eq(pairingDecisions.status, "split"));
  for (const row of variantLinkRows) {
    const url = extractSupplierLink(row.url).url;
    const host = url === null ? "" : hostOf(url);
    if (url !== null && host !== "" && !isOwnShopHost(host)) links.add(url);
  }

  return [...links].sort((a, b) => a.localeCompare(b));
}

/**
 * Počet odkazov na NÁŠ VLASTNÝ e-shop, extrahovaných živo z `internalNote`
 * (issue 227) — pre obrazovku, aby vylúčenie nebolo tiché: majiteľ vidí,
 * koľko odkazov sa NEscrapuje a prečo ("toto nie je dodávateľský odkaz").
 * Počíta UNIKÁTNE odkazy, rovnaká jednotka ako `collectSupplierLinks`.
 */
export async function countOwnShopLinks(db: Database): Promise<number> {
  const rows = await db
    .select({ internalNote: products.internalNote })
    .from(products)
    .where(isNotNull(products.internalNote));
  const links = new Set<string>();
  for (const row of rows) {
    const url = extractSupplierLink(row.internalNote).url;
    const host = url === null ? "" : hostOf(url);
    if (url !== null && host !== "" && isOwnShopHost(host)) links.add(url);
  }
  return links.size;
}

/**
 * NAŠE `variant.size_label` hodnoty zoskupené podľa dodávateľskej linky
 * (issue 224) — čo touto linkou treba spárovať, keď má doména pravidlo na
 * čítanie zoznamu veľkostí (`parseSizeAvailability`). Variant bez veľkosti
 * (`null`/prázdne) sa NEZAHRNIE — nedal by sa spárovať a písal by
 * zavádzajúci blanket (`''`) riadok popri riadkoch ostatných veľkostí tej
 * istej linky (viď `writeSupplierStockRows`).
 */
export async function collectOurSizesByLink(db: Database): Promise<Map<string, readonly string[]>> {
  const rows = await db
    .select({ productKey: products.key, internalNote: products.internalNote, sizeLabel: variants.sizeLabel })
    .from(variants)
    .innerJoin(products, eq(variants.productKey, products.key));
  // issue 585 (code review): kľúč je EFEKTÍVNY odkaz (override ∪ internalNote) —
  // ten istý ako `collectSupplierLinks` aj `restock/queries.ts`. Pred tým sa
  // naše veľkosti zbierali len z `internalNote`, takže produkt s odkazom z
  // Párovania/Vyhľadať dostal `ourSizes=[]` → plošný riadok zo štítku pri cene
  // → restock prepol aj veľkosti, ktoré dodávateľ nemá.
  const overrideByProduct = await loadOverrideMap(db);
  const byLink = new Map<string, Set<string>>();
  for (const row of rows) {
    const url = resolveEffectiveSupplierLink(row.internalNote, overrideByProduct.get(row.productKey) ?? null).url;
    if (url === null || hostOf(url) === "") continue;
    const label = (row.sizeLabel ?? "").trim();
    if (label === "") continue;
    const set = byLink.get(url) ?? new Set<string>();
    set.add(label);
    byLink.set(url, set);
  }
  return new Map([...byLink].map(([link, set]) => [link, [...set]]));
}
