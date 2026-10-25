// issue 402: doplnkový beh nad `shop_product_url` — sitemap.xml prechod
// (zadarmo, žiadna sieťová sonda na produkt) → HTTP probe prechod (časovo
// rozpočtovaný, `pairing-search/run.ts`'s vzor) pre zvyšok. Zapisuje LEN
// kódy, čo `feed` nepokrýva; NIKDY neprepíše feedom potvrdený riadok
// (`onConflictDoNothing` na `code` — bezpečné aj pri race s iným behom).

import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { shopProductUrl } from "../../db/schema.js";
import { log } from "../../logger.js";
import { isShoptetBlockedError } from "../shoptet-http/blocked.js";
import { candidateSlugs, resolveProbe, type ProbeFetch } from "./candidates.js";
import {
  MAX_PROBE_REQUESTS_PER_RUN,
  MIN_SITEMAP_LOCS,
  PROBE_COOLDOWN_DAYS,
  RUN_TIME_BUDGET_MS,
  SHOP_SITEMAP_RUN_LOCK_KEY,
} from "./constants.js";
import { createHttpProbeFetcher } from "./probe-fetcher.js";
import {
  recordProbeAttempts,
  selectExistingSitemapProbeUrls,
  selectMissingProducts,
  selectProbeAttempts,
  type MissingProduct,
} from "./select.js";
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
  /** `true` = probe prechod sa zastavil PRED spracovaním celého zvyšku (`stoppedReason`) — pokračuje nasledujúcu noc. */
  readonly stoppedEarly: boolean;
  /** issue 598: prečo sa probe prechod zastavil skôr — časový rozpočet, strop požiadaviek, alebo bloková stránka Shoptetu; `null` = prešiel celý zvyšok. */
  readonly stoppedReason: ProbeStopReason | null;
  /** issue 598: koľko produktov probe prechod skutočne sondoval. */
  readonly probedProducts: number;
  /** issue 598: koľko HTTP sond (kandidátnych adries) odišlo na e-shop. */
  readonly probeRequests: number;
  /** issue 598: koľko produktov sa preskočilo, lebo ich sonda neúspešne skúšala v posledných `PROBE_COOLDOWN_DAYS` dňoch. */
  readonly skippedCooldown: number;
}

export type ProbeStopReason = "time_budget" | "request_cap" | "shoptet_blocked";

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
  /** issue 598: strop HTTP sond na beh (predvolene `MAX_PROBE_REQUESTS_PER_RUN`). */
  readonly maxProbeRequests?: number;
  /** issue 598: ochranná doba po neúspešnom pokuse (predvolene `PROBE_COOLDOWN_DAYS`). */
  readonly cooldownDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

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

// issue 413: exportované pre `startRunNow` (`modules/scheduler/run-now.ts`),
// rovnaký dôvod ako `posta-uncollected/run.ts`'s `runPostaUncollectedLocked`.
export async function runShopSitemapLocked(options: RunShopSitemapOptions): Promise<ShopSitemapRunResult> {
  const { db, now } = options;
  const fetchSitemap = options.fetchSitemap ?? createHttpSitemapFetcher();
  const fetchCandidate = options.fetchCandidate ?? createHttpProbeFetcher();
  const clock = options.clock ?? Date.now;
  const timeBudgetMs = options.timeBudgetMs ?? RUN_TIME_BUDGET_MS;
  const deadline = clock() + timeBudgetMs;
  const maxProbeRequests = options.maxProbeRequests ?? MAX_PROBE_REQUESTS_PER_RUN;
  const cooldownDays = options.cooldownDays ?? PROBE_COOLDOWN_DAYS;

  const missing = await selectMissingProducts(db);
  if (missing.length === 0) {
    const [count] = await db.select({ value: sql<number>`count(*)::int` }).from(shopProductUrl);
    return {
      missingProducts: 0,
      resolvedBySitemap: 0,
      resolvedByProbe: 0,
      codesAttempted: 0,
      totalStored: count?.value ?? 0,
      stoppedEarly: false,
      stoppedReason: null,
      probedProducts: 0,
      probeRequests: 0,
      skippedCooldown: 0,
    };
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

  // --- Probe prechod (časovo rozpočtovaný + strop požiadaviek, issue 598) ---
  const { queue, skippedCooldown } = orderProbeQueue(remainder, await selectProbeAttempts(db), now, cooldownDays);
  let probeRequests = 0;
  const countedFetch: ProbeFetch = (candidate) => {
    probeRequests += 1;
    return fetchCandidate(candidate);
  };
  const probedResults: ResolveResult[] = [];
  const probedProducts: MissingProduct[] = [];
  let stoppedReason: ProbeStopReason | null = null;
  for (const p of queue) {
    if (clock() >= deadline) {
      stoppedReason = "time_budget";
      break;
    }
    if (probeRequests + candidateSlugs(p.name).length > maxProbeRequests) {
      stoppedReason = "request_cap";
      break;
    }
    try {
      probedResults.push(await resolveProbe(p.name, countedFetch));
    } catch (error) {
      if (!isShoptetBlockedError(error)) throw error;
      // Prerušený produkt sa NEZAPÍŠE ako skúšaný — dostane šancu znova.
      stoppedReason = "shoptet_blocked";
      log.warn({ probeRequests, probedProducts: probedProducts.length }, "shop-sitemap: Shoptet zablokoval IP — probe prechod sa zastavuje");
      break;
    }
    probedProducts.push(p);
  }

  const probeDeduped = dedup([...probedResults, ...lockedForProbe]);
  let resolvedByProbe = 0;
  const failedProbeKeys: string[] = [];
  probedProducts.forEach((p, i) => {
    const url = probeDeduped.get(i) ?? null;
    if (url !== null) {
      resolvedByProbe += 1;
      for (const code of p.missingCodes) toWrite.push({ code, url, source: "probe" });
    } else {
      failedProbeKeys.push(p.productKey);
    }
  });

  // --- Zápis: LEN kódy bez existujúceho riadku, NIKDY neprepíše (aj pri race) ---
  if (toWrite.length > 0) {
    for (let i = 0; i < toWrite.length; i += CHUNK) {
      const chunk = toWrite.slice(i, i + CHUNK).map((row) => ({ code: row.code, url: row.url, source: row.source, fetchedAt: now }));
      await db.insert(shopProductUrl).values(chunk).onConflictDoNothing({ target: shopProductUrl.code });
    }
  }

  await recordProbeAttempts(db, failedProbeKeys, now);

  const [count] = await db.select({ value: sql<number>`count(*)::int` }).from(shopProductUrl);
  const result: ShopSitemapRunResult = {
    missingProducts: missing.length,
    resolvedBySitemap,
    resolvedByProbe,
    codesAttempted: toWrite.length,
    totalStored: count?.value ?? 0,
    stoppedEarly: stoppedReason !== null,
    stoppedReason,
    probedProducts: probedProducts.length,
    probeRequests,
    skippedCooldown,
  };
  log.info({ ...result, queue: queue.length, maxProbeRequests, cooldownDays }, "shop-sitemap: beh dobehol");
  return result;
}

/**
 * issue 598: poradie probe prechodu. Pred touto zmenou sa sondoval zvyšok v
 * pevnom poradí `productKey` a každú noc od začiatku — beh narazil na časový
 * rozpočet vždy na TOM ISTOM mieste a ku koncu zoznamu sa nikdy nedostal.
 * Teraz: produkty neúspešne skúšané v posledných `cooldownDays` dňoch sa
 * vynechajú, NIKDY neskúšané idú prvé (stabilne podľa `productKey`), potom
 * najdávnejšie skúšané.
 */
function orderProbeQueue(
  remainder: readonly MissingProduct[],
  attempts: ReadonlyMap<string, Date>,
  now: Date,
  cooldownDays: number,
): { readonly queue: readonly MissingProduct[]; readonly skippedCooldown: number } {
  const cooldownStart = now.getTime() - cooldownDays * DAY_MS;
  const never: MissingProduct[] = [];
  const stale: { readonly product: MissingProduct; readonly at: number }[] = [];
  let skippedCooldown = 0;
  for (const p of remainder) {
    const attemptedAt = attempts.get(p.productKey);
    if (attemptedAt === undefined) never.push(p);
    else if (attemptedAt.getTime() > cooldownStart) skippedCooldown += 1;
    else stale.push({ product: p, at: attemptedAt.getTime() });
  }
  stale.sort((a, b) => a.at - b.at || a.product.productKey.localeCompare(b.product.productKey));
  return { queue: [...never, ...stale.map((s) => s.product)], skippedCooldown };
}
