// issue 402: stiahnutie + rozobratie forestshop.sk's `sitemap.xml`. Rovnaký
// tvar ako `shop-feed/fetcher.ts` (`readBounded` PREBERÁ z `catalog/
// fetcher.ts` — strop musí platiť POČAS čítania, nie až po zbufferovaní
// celého tela).

import { readBounded } from "../catalog/fetcher.js";
import { DEFAULT_SITEMAP_URL, MAX_SITEMAP_BYTES, REQUEST_TIMEOUT_MS } from "./constants.js";

/** Stiahne surové telo sitemapy. Vstrekované, aby testy nikdy nešli na živý e-shop. */
export type SitemapFetcher = () => Promise<string>;

export function createHttpSitemapFetcher(url: string = DEFAULT_SITEMAP_URL): SitemapFetcher {
  return async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Sitemapa ${url} vrátila HTTP ${String(response.status)}`);
      }
      const body = await readBounded(response, MAX_SITEMAP_BYTES);
      return body.toString("utf8");
    } finally {
      clearTimeout(timer);
    }
  };
}

const LOC_TAG = /<loc>([\s\S]*?)<\/loc>/g;

/**
 * Vráti sitemap SLUGY (cesta bez domény, bez vedúcej/koncovej lomky) — presne
 * to, čo `url-resolver.ts`'s `buildIndex` porovnáva proti slugifikovaným
 * menám produktov. Riadok, čo sa nezhoduje s `https://www.forestshop.sk/…`
 * (napr. iná doména/CDN), sa PRESKOČÍ — sitemapa tejto appky nesie len
 * vlastné produktové stránky, ale robustnosť voči cudziemu riadku je lacná.
 */
export function parseSitemapSlugs(xml: string): readonly string[] {
  const slugs: string[] = [];
  for (const [, rawLoc] of xml.matchAll(LOC_TAG)) {
    if (rawLoc === undefined) continue;
    const loc = rawLoc.trim();
    let url: URL;
    try {
      url = new URL(loc);
    } catch {
      continue;
    }
    if (url.hostname !== "www.forestshop.sk" && url.hostname !== "forestshop.sk") continue;
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    if (path === "") continue;
    slugs.push(path);
  }
  return slugs;
}
