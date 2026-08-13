// issue 402: doplnkový beh nad `shop_product_url` — sitemap.xml prechod
// (zadarmo, žiadna sieťová sonda na produkt) → HTTP probe prechod (časovo
// rozpočtovaný, `pairing-search/run.ts`'s vzor) pre zvyšok. Zapisuje LEN
// kódy, čo `feed` nepokrýva; NIKDY neprepíše feedom potvrdený riadok
// (`onConflictDoNothing` na `code` — bezpečné aj pri race s iným behom).

import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { shopProductUrl } from "../../db/schema.js";
import { resolveProbe, type ProbeFetch } from "./candidates.js";
import { MIN_SITEMAP_LOCS, RUN_TIME_BUDGET_MS, SHOP_SITEMAP_RUN_LOCK_KEY } from "./constants.js";
import { createHttpProbeFetcher } from "./probe-fetcher.js";
import { selectExistingSitemapProbeUrls, selectMissingProducts, type MissingProduct } from "./select.js";
import { createHttpSitemapFetcher, parseSitemapSlugs, type SitemapFetcher } from "./sitemap-fetcher.js";
import { slug } from "./slug.js";
import { buildIndex, dedup, resolve, STRENGTH_EXISTING, type ResolveResult } from "./url-resolver.js";

export interface ShopSitemapRunResult {
  /** Koľko produktov malo na začiatku behu aspoň jeden variant bez `shop_product_url` riadku. */
  readonly missingProducts: number;
  /** Koľko z nich vyriešil sitemap prechod (zadarmo, bez sondy). */
  readonly resolvedBySitemap: number;
  /** Koľko z NEVYRIEŠENÝCH sitemapou vyriešil probe prechod. */
  readonly resolvedByProbe: number;
  /** Koľko riadkov (kódov variantov) tento beh POKÚSIL zapísať (`onConflictDoNothing` — skutočný počet môže byť nižší pri race). */
  readonly codesAttempted: number;
  /** Koľko riadkov je v mape PO tomto behu — rovnaký tvar ako `shop-feed`'s `stored`. */
  readonly totalStored: number;
  /** `true` = probe prechod sa zastavil na časovom rozpočte PRED spracovaním celého zvyšku — pokračuje nasledujúcu noc (populácia bez riadku ostáva rovnaká, `select.ts`). */
  readonly stoppedEarly: boolean;
}

export interface RunShopSitemapOptions {
  readonly db: Database;
  readonly now: Date;
  /** Predvolene skutočný HTTP fetch (`createHttpSitemapFetcher()`) — testy vstrekujú vlastný, nikdy nejdú na živý e-shop. */
  readonly fetchSitemap?: SitemapFetcher;
  /** Predvolene skutočná throttled HTTP sonda (`createHttpProbeFetcher()`) — testy vstrekujú vlastný. */
  readonly fetchCandidate?: ProbeFetch;
  /** Vstrekovateľné pre testy (`RUN_TIME_BUDGET_MS`'s deterministický test, rovnaký vzor ako `pairing-search/run.ts`). */
  readonly clock?: () => number;
  readonly timeBudgetMs?: number;
}

const CHUNK = 500;

/**
 * Vonkajší obal berúci `SHOP_SITEMAP_RUN_LOCK_KEY` — tento job MÁ manuálny
 * "Spustiť teraz" trigger NA TÚ ISTÚ prácu ako naplánovaný nočný beh (rovnaký
 * dôvod ako `pairing-search/run.ts`'s `runPairingSearch`/`POSTA_UNCOLLECTED_
 * RUN_LOCK_KEY`), takže potrebuje VLASTNÝ zámok, nie len scheduler tick()'s
 * `SCHEDULER_ADVISORY_LOCK_KEY`. `pg_advisory_lock` (session-scoped, na
 * vlastnom vyhradenom pripojení z poolu) — NIE transakcia okolo celého behu,
 * lebo beh robí desiatky sekvenčných HTTP sond, ktoré by zbytočne zaťažovali
 * connection pool, keby ich obopínala jedna otvorená DB transakcia.
 */
export async function runShopSitemap(options: RunShopSitemapOptions): Promise<ShopSitemapRunResult> {
  const { db } = options;
  const lockClient = await db.$client.connect();
  try {
    await lockClient.query("select pg_advisory_lock($1)", [SHOP_SITEMAP_RUN_LOCK_KEY]);
    return await runShopSitemapLocked(options);
  } finally {
    await lockClient.query("select pg_advisory_unlock($1)", [SHOP_SITEMAP_RUN_LOCK_KEY]);
    lockClient.release();
  }
}

async function runShopSitemapLocked(options: RunShopSitemapOptions): Promise<ShopSitemapRunResult> {
  const { db, now } = options;
  const fetchSitemap = options.fetchSitemap ?? createHttpSitemapFetcher();
  const fetchCandidate = options.fetchCandidate ?? createHttpProbeFetcher();
  const clock = options.clock ?? Date.now;
  const timeBudgetMs = options.timeBudgetMs ?? RUN_TIME_BUDGET_MS;
  const deadline = clock() + timeBudgetMs;

  const missing = await selectMissingProducts(db);
  if (missing.length === 0) {
    const [count] = await db.select({ value: sql<number>`count(*)::int` }).from(shopProductUrl);
    return { missingProducts: 0, resolvedBySitemap: 0, resolvedByProbe: 0, codesAttempted: 0, totalStored: count?.value ?? 0, stoppedEarly: false };
  }

  // Poistka PRED zápisom (rovnaký princíp ako `shop-feed/run.ts`'s
  // `MIN_ENTRIES`): pokazená/prázdna sitemapa nesmie spôsobiť, že KAŽDÝ
  // produkt spadne rovno do (drahého, zbytočného) probe prechodu.
  const sitemapXml = await fetchSitemap();
  const sitemapSlugs = parseSitemapSlugs(sitemapXml);
  if (sitemapSlugs.length < MIN_SITEMAP_LOCS) {
    throw new Error(
      `Sitemapa obsahovala len ${String(sitemapSlugs.length)} použiteľných URL (očakávaných aspoň ${String(MIN_SITEMAP_LOCS)}) — beh sa zastavuje bez zápisu`,
    );
  }

  const existing = await selectExistingSitemapProbeUrls(db);
  const existingEntries: ResolveResult[] = existing.map((e) => ({ url: e.url, strength: STRENGTH_EXISTING, nameSlug: e.nameSlug }));

  // --- Sitemap prechod (zadarmo) ---
  const index = buildIndex(sitemapSlugs);
  const sitemapResolved = missing.map((p) => resolve(p.name, index));
  const sitemapDeduped = dedup([...sitemapResolved, ...existingEntries]);

  const toWrite: { code: string; url: string; source: "sitemap" | "probe" }[] = [];
  const remainder: MissingProduct[] = [];
  // Sitemapou vyriešené URL sa "zamknú" na STRENGTH_EXISTING pre probe
  // prechod nižšie — probe kandidát ich nikdy nesmie ukradnúť.
  const lockedForProbe: ResolveResult[] = [...existingEntries];

  missing.forEach((p, i) => {
    const url = sitemapDeduped.get(i) ?? null;
    if (url !== null) {
      for (const code of p.missingCodes) toWrite.push({ code, url, source: "sitemap" });
      lockedForProbe.push({ url, strength: STRENGTH_EXISTING, nameSlug: slug(p.name) });
    } else {
      remainder.push(p);
    }
  });
  const resolvedBySitemap = missing.length - remainder.length;

  // --- Probe prechod (časovo rozpočtovaný) ---
  const probedResults: ResolveResult[] = [];
  const probedProducts: MissingProduct[] = [];
  let stoppedEarly = false;
  for (const p of remainder) {
    if (clock() >= deadline) {
      stoppedEarly = true;
      break;
    }
    probedResults.push(await resolveProbe(p.name, fetchCandidate));
    probedProducts.push(p);
  }

  const probeDeduped = dedup([...probedResults, ...lockedForProbe]);
  let resolvedByProbe = 0;
  probedProducts.forEach((p, i) => {
    const url = probeDeduped.get(i) ?? null;
    if (url !== null) {
      resolvedByProbe += 1;
      for (const code of p.missingCodes) toWrite.push({ code, url, source: "probe" });
    }
  });

  // --- Zápis: LEN kódy bez existujúceho riadku, NIKDY neprepíše (aj pri race) ---
  if (toWrite.length > 0) {
    for (let i = 0; i < toWrite.length; i += CHUNK) {
      const chunk = toWrite.slice(i, i + CHUNK).map((row) => ({ code: row.code, url: row.url, source: row.source, fetchedAt: now }));
      await db.insert(shopProductUrl).values(chunk).onConflictDoNothing({ target: shopProductUrl.code });
    }
  }

  const [count] = await db.select({ value: sql<number>`count(*)::int` }).from(shopProductUrl);
  return {
    missingProducts: missing.length,
    resolvedBySitemap,
    resolvedByProbe,
    codesAttempted: toWrite.length,
    totalStored: count?.value ?? 0,
    stoppedEarly,
  };
}
