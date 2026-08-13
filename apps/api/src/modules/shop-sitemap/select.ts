// issue 402: výber populácie pre `shop-sitemap` beh — rovnaký MVP vzor ako
// `pairing-search/select.ts`/`product-links/queries.ts` (celý katalóg sa
// načíta a zoskupí v pamäti, žiadny SQL JOIN so vstavaným slugify-om).

import { inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { products, shopProductUrl, variants } from "../../db/schema.js";
import { slug } from "./slug.js";

export interface MissingProduct {
  readonly productKey: string;
  readonly name: string;
  /** Kódy variantov TOHTO produktu, čo ešte NEMAJÚ ŽIADEN riadok v `shop_product_url` (feed ich nepokrýva). */
  readonly missingCodes: readonly string[];
}

/**
 * Produkty, ktoré majú aspoň jeden variant BEZ riadku v `shop_product_url`
 * (bez ohľadu na to, akým bude/bol vyriešený — `feed`u chýbajúci kód je
 * jediná podmienka). Zámerne sa NEOPAKUJE kód, čo už riadok MÁ (aj keby
 * mal `source: 'sitemap'/'probe'`) — jednorazovo vyriešený kód sa v ĎALŠOM
 * behu neprebieha znova (zadanie: "sonduj len kandidátov produktov, ktoré
 * URL nemajú").
 */
export async function selectMissingProducts(db: Database): Promise<readonly MissingProduct[]> {
  const variantRows = await db.select({ code: variants.code, productKey: variants.productKey }).from(variants);
  if (variantRows.length === 0) return [];

  const codesByProduct = new Map<string, string[]>();
  for (const row of variantRows) {
    const bucket = codesByProduct.get(row.productKey);
    if (bucket === undefined) codesByProduct.set(row.productKey, [row.code]);
    else bucket.push(row.code);
  }

  const existingCodeRows = await db.select({ code: shopProductUrl.code }).from(shopProductUrl);
  const existingCodes = new Set(existingCodeRows.map((r) => r.code));

  const productKeysWithGap: string[] = [];
  for (const [productKey, codes] of codesByProduct) {
    if (codes.some((c) => !existingCodes.has(c))) productKeysWithGap.push(productKey);
  }
  if (productKeysWithGap.length === 0) return [];

  const productRows = await db.select({ key: products.key, name: products.name }).from(products).where(inArray(products.key, productKeysWithGap));

  const result: MissingProduct[] = [];
  for (const p of productRows) {
    const codes = codesByProduct.get(p.key) ?? [];
    const missingCodes = codes.filter((c) => !existingCodes.has(c));
    if (missingCodes.length > 0) result.push({ productKey: p.key, name: p.name, missingCodes });
  }
  // Deterministické poradie — rovnaký princíp ako `pairing-search/select.ts`.
  result.sort((a, b) => a.productKey.localeCompare(b.productKey));
  return result;
}

export interface ExistingResolvedUrl {
  readonly url: string;
  readonly nameSlug: string;
}

/**
 * URL už priradené TÝMTO behom (`source: 'sitemap'/'probe'`) v NIEKTOROM
 * PREDOŠLOM behu — sentinel pre `dedup()`, aby produkt vyriešený DNES nikdy
 * neukradol URL produktu vyriešeného VČERA (`url-resolver.ts`'s
 * `STRENGTH_EXISTING`). Feedom potvrdené riadky (`source: 'feed'`) sa
 * ZÁMERNE nezahŕňajú — nesú `?variantId=…` tvar, ktorý sa s holým
 * produktovým slugom prakticky nikdy nezhoduje (design komentár na
 * tickete).
 */
export async function selectExistingSitemapProbeUrls(db: Database): Promise<readonly ExistingResolvedUrl[]> {
  const rows = await db
    .select({ code: shopProductUrl.code, url: shopProductUrl.url, source: shopProductUrl.source })
    .from(shopProductUrl);
  const sitemapOrProbeRows = rows.filter((r) => r.source === "sitemap" || r.source === "probe");
  if (sitemapOrProbeRows.length === 0) return [];

  const codes = sitemapOrProbeRows.map((r) => r.code);
  const variantRows = await db.select({ code: variants.code, productKey: variants.productKey }).from(variants).where(inArray(variants.code, codes));
  const productKeyByCode = new Map(variantRows.map((v) => [v.code, v.productKey]));

  const productKeys = [...new Set(variantRows.map((v) => v.productKey))];
  const productRows = productKeys.length === 0 ? [] : await db.select({ key: products.key, name: products.name }).from(products).where(inArray(products.key, productKeys));
  const nameByProductKey = new Map(productRows.map((p) => [p.key, p.name]));

  const seenUrls = new Set<string>();
  const out: ExistingResolvedUrl[] = [];
  for (const row of sitemapOrProbeRows) {
    if (seenUrls.has(row.url)) continue;
    const productKey = productKeyByCode.get(row.code);
    // Osirotený riadok (variant medzičasom zmizol z katalógu) — bez mena
    // produktu sa nedá zaradiť do dedupu, preskočí sa (rovnaká disciplína
    // ako `pairing-review/queries.ts`'s osirotený `pairing_candidate_set`).
    if (productKey === undefined) continue;
    const name = nameByProductKey.get(productKey);
    if (name === undefined) continue;
    seenUrls.add(row.url);
    out.push({ url: row.url, nameSlug: slug(name) });
  }
  return out;
}
