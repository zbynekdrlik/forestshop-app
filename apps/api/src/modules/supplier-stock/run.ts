// Beh scrapera dostupnosti u dodávateľa (issue 212, per veľkosť issue 224).
//
// Sériový, zámerne: 969 z 1 210 riadkov reálneho exportu je JEDNA doména
// (`huntingshop.eu`), takže paralelné sťahovanie by na ňu vyzeralo ako útok.
// Medzi dvomi požiadavkami na tú istú doménu je pauza (`PER_HOST_DELAY_MS`).

import { and, eq, isNotNull, like, notInArray, or } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairingDecisions, pairingVariantLinks, productSupplierLinkOverrides, products, supplierStock, variants } from "../../db/schema.js";
import { log } from "../../logger.js";
import { extractSupplierLink } from "../catalog/supplier-link.js";
import { resolveEffectiveSupplierLink } from "../orders/effective-supplier-link.js";
import { MAX_AGE_HOURS, OWN_SHOP_HOST, PER_HOST_DELAY_MS, SUPPLIER_STOCK_RUN_LOCK_KEY } from "./constants.js";
import type { PageFetcher } from "./page-fetcher.js";
import {
  foldMultiTokenSizeAvailability,
  hasSizeAvailabilityRule,
  hostOf,
  matchSizeLabel,
  mergeSizeAvailability,
  type ParsedPage,
  parseCombinationResponse,
  parsePage,
  parseSizeAvailability,
  type SizeAvailability,
  sizeCombinationEnumeratorFor,
  type SupplierAvailability,
  type SupplierStockSource,
} from "./parse.js";

export interface SupplierStockRunResult {
  /** Koľko unikátnych liniek katalóg vôbec obsahuje. */
  readonly total: number;
  /** Preskočené, lebo majú čerstvú úspešnú kontrolu. */
  readonly skipped: number;
  readonly checked: number;
  /** Počty sú za ZAPÍSANÉ riadky (link, veľkosť), nie za linky — rovnaká
   * jednotka ako `getSupplierStockOverview` (`queries.ts`), takže si oba
   * súhlasia. Jednoveľkostná/blanket linka prispieva presne 1, linka s
   * pravidlom na veľkosti prispieva po jednej za KAŽDÚ našu veľkosť. */
  readonly available: number;
  readonly unavailable: number;
  readonly unknown: number;
  /** Kontrola sama zlyhala (sieť, časový limit, HTTP chyba) — za LINKU. */
  readonly failed: number;
  readonly hosts: readonly string[];
  /** issue 552: počty HTTP requestov + čas per host (base GET + enumeračné
   * `action=refresh` GET-y). Pre `job_run.detail` — sledovanie nákladov
   * enumerácie (či nočný beh nepresiahne 2 h). `hosts` ostáva pre spätnú
   * kompatibilitu UI; `hostStats` je len navyše (UI Zod schéma neznáme kľúče
   * strippuje). */
  readonly hostStats: readonly SupplierStockHostStat[];
}

export interface SupplierStockHostStat {
  readonly host: string;
  /** Všetky HTTP requesty na tento host (base + enumeračné). */
  readonly requests: number;
  /** Z toho enumeračných (`action=refresh`) — koľko navyše stála fáza 2. */
  readonly enumerationRequests: number;
  /** Wall-clock od prvého po posledný request na tomto hoste. Beh je sériový a
   * odkazy sú zoradené (rovnaký host je spravidla súvislo), takže to je dobrý
   * odhad času stráveného na hoste vrátane `PER_HOST_DELAY_MS` páuz — POZOR,
   * ak sa hosty prekladajú, zahŕňa aj čas strávený medzitým na INÝCH hostoch
   * (diagnostika pre `job_run.detail`, nie presné meranie, code review 🔵). */
  readonly elapsedMs: number;
}

export interface RunSupplierStockOptions {
  readonly db: Database;
  readonly now: Date;
  readonly fetchPage: PageFetcher;
  /** Iba pre testy — bez neho beh reálne čaká medzi doménami. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Iba pre testy/ručný beh — obmedzí počet skutočne kontrolovaných liniek. */
  readonly limit?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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
  const overrideRows = await db
    .select({ productKey: productSupplierLinkOverrides.productKey, url: productSupplierLinkOverrides.url })
    .from(productSupplierLinkOverrides);
  const overrideByProduct = new Map(overrideRows.map((r) => [r.productKey, r.url]));
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
async function collectOurSizesByLink(db: Database): Promise<Map<string, readonly string[]>> {
  const rows = await db
    .select({ internalNote: products.internalNote, sizeLabel: variants.sizeLabel })
    .from(variants)
    .innerJoin(products, eq(variants.productKey, products.key));
  const byLink = new Map<string, Set<string>>();
  for (const row of rows) {
    const url = extractSupplierLink(row.internalNote).url;
    if (url === null || hostOf(url) === "") continue;
    const label = (row.sizeLabel ?? "").trim();
    if (label === "") continue;
    const set = byLink.get(url) ?? new Set<string>();
    set.add(label);
    byLink.set(url, set);
  }
  return new Map([...byLink].map(([link, set]) => [link, [...set]]));
}

/**
 * `true`, keď má linka ÚSPEŠNÚ kontrolu mladšiu než `MAX_AGE_HOURS`.
 * Zlyhaná kontrola sa zámerne NEPOČÍTA — inak by stránka, ktorá stabilne
 * padá na časovom limite, ostala „čerstvá" a nikdy by sa neskúsila znova.
 */
export function isFresh(
  previous: { readonly ok: boolean; readonly confirmedAt: Date | null } | undefined,
  now: Date,
  maxAgeHours = MAX_AGE_HOURS,
): boolean {
  if (previous === undefined || !previous.ok || previous.confirmedAt === null) return false;
  const ageMs = now.getTime() - previous.confirmedAt.getTime();
  return ageMs >= 0 && ageMs <= maxAgeHours * 3_600_000;
}

export async function runSupplierStock(options: RunSupplierStockOptions): Promise<SupplierStockRunResult> {
  const { db } = options;
  const lockClient = await db.$client.connect();
  try {
    await lockClient.query("select pg_advisory_lock($1)", [SUPPLIER_STOCK_RUN_LOCK_KEY]);
    return await runSupplierStockLocked(options);
  } finally {
    await lockClient.query("select pg_advisory_unlock($1)", [SUPPLIER_STOCK_RUN_LOCK_KEY]);
    lockClient.release();
  }
}

export interface StockRowInput {
  readonly sizeLabel: string;
  readonly availability: SupplierAvailability;
  readonly availabilityText: string;
  readonly price: number | null;
  readonly source: SupplierStockSource;
}

/**
 * Poskladá riadky pre JEDNU linku z (už zlúčeného, issue 552) zoznamu veľkostí
 * a prečítanej stránky — ČISTÁ funkcia (testovateľná bez DB/siete).
 *
 * Tri cesty:
 *  1. `sizeList` čitateľný + máme veľkosti → per-veľkosť riadok. Priama zhoda
 *     (`matchSizeLabel`); ak zlyhá, PÁROVÝ štítok sa zloží z jednotlivých čísel
 *     dodávateľa (`foldMultiTokenSizeAvailability`, issue 558 A). Bez zhody →
 *     `unknown`/`none`.
 *  2. `sizeList` === null na doméne so SIZE pravidlom a držíme >1 veľkosť →
 *     per-veľkosť `unknown` NAMIESTO plošného riadku (issue 558 B). Plošný `''`
 *     riadok by sa cez `size_label=''` JOIN (`restock/queries.ts`) spároval s
 *     KAŽDOU našou veľkosťou — presne ten over-match, aký issue 551 rieši pre
 *     wetland; per-veľkosť `unknown` nič neprepne (kandidát vyžaduje `available`).
 *  3. inak (host bez SIZE pravidla, alebo ≤1 veľkosť) → plošný riadok z
 *     `parsePage` (nezmenené správanie pre Ballistol/jednoveľkostné produkty).
 */
export function buildSizeStockRows(args: {
  readonly ourSizes: readonly string[];
  readonly sizeList: readonly SizeAvailability[] | null;
  readonly hostHasSizeRule: boolean;
  readonly page: ParsedPage;
}): readonly StockRowInput[] {
  const { ourSizes, sizeList, hostHasSizeRule, page } = args;
  const perSize = sizeList !== null ? ourSizes.length > 0 : hostHasSizeRule && ourSizes.length > 1;
  if (!perSize) {
    return [
      {
        sizeLabel: "",
        availability: page.availability,
        availabilityText: page.availabilityText,
        price: page.price,
        source: page.source,
      },
    ];
  }
  const list = sizeList ?? [];
  const labels = list.map((s) => s.sizeLabel);
  return ourSizes.map((ourLabel): StockRowInput => {
    const matched = matchSizeLabel(ourLabel, labels);
    const hit = matched === null ? null : (list.find((s) => s.sizeLabel === matched) ?? null);
    if (hit !== null) {
      return { sizeLabel: ourLabel, availability: hit.availability, availabilityText: hit.sizeLabel, price: page.price, source: "size_list" };
    }
    const folded = foldMultiTokenSizeAvailability(ourLabel, list);
    if (folded !== null && folded.availability !== "unknown") {
      return { sizeLabel: ourLabel, availability: folded.availability, availabilityText: folded.matchedLabels.join(", "), price: page.price, source: "size_list" };
    }
    return { sizeLabel: ourLabel, availability: "unknown", availabilityText: "", price: page.price, source: "none" };
  });
}

// issue 413: exportované pre `startRunNow` (`modules/scheduler/run-now.ts`),
// rovnaký dôvod ako `posta-uncollected/run.ts`'s `runPostaUncollectedLocked`.
export async function runSupplierStockLocked(options: RunSupplierStockOptions): Promise<SupplierStockRunResult> {
  const { db, now, fetchPage } = options;
  const sleep = options.sleep ?? defaultSleep;

  // issue 227: staré riadky z BEHOV PRED touto opravou (keď sa vlastný
  // e-shop ešte scrapoval) sa vymažú pri KAŽDOM behu — nikdy nemajú dôvod
  // v tabuľke byť, takže ich ponechanie by ich tvárilo ako "nečitateľnú
  // dodávateľskú doménu" navždy namiesto toho, aby jednoducho zmizli.
  await db
    .delete(supplierStock)
    .where(or(eq(supplierStock.host, OWN_SHOP_HOST), like(supplierStock.host, `%.${OWN_SHOP_HOST}`)));

  const links = await collectSupplierLinks(db);
  const ourSizesByLink = await collectOurSizesByLink(db);
  // Všetky riadky tej istej linky sa píšu/aktualizujú v TOM ISTOM behu
  // (`writeSupplierStockRows`), takže "je táto linka čerstvá" musí platiť
  // pre KAŽDÝ jej riadok naraz — keby čo i len jedna veľkosť ešte nemala
  // čerstvé potvrdenie, celá linka sa musí skúsiť znova (jeden fetch aj tak
  // vždy prepíše všetky veľkosti tej istej linky).
  const existing = await db
    .select({
      link: supplierStock.link,
      sizeLabel: supplierStock.sizeLabel,
      ok: supplierStock.ok,
      confirmedAt: supplierStock.confirmedAt,
    })
    .from(supplierStock);
  const rowsByLink = new Map<
    string,
    { readonly sizeLabel: string; readonly ok: boolean; readonly confirmedAt: Date | null }[]
  >();
  for (const row of existing) {
    const rows = rowsByLink.get(row.link) ?? [];
    rows.push(row);
    rowsByLink.set(row.link, rows);
  }
  const isLinkFresh = (link: string): boolean => {
    const rows = rowsByLink.get(link);
    if (rows === undefined || rows.length === 0) return false;
    // issue 551 (dodatok): plošný riadok (`size_label=''`) na doméne s
    // per-veľkosť pravidlom, pre ktorú MÁME naše veľkosti, mohla zapísať len
    // STARŠIA verzia pravidla — nikdy nie je čerstvý, aby ho nasledujúci beh
    // prepísal per-veľkosť riadkami (inak by `restock` blanket-párovanie
    // prepínalo cudzie veľkosti až do vypršania `MAX_AGE_HOURS`). Odkazy bez
    // našich veľkostí (Ballistol) si plošný riadok + normálnu čerstvosť držia.
    // Pozn.: odkaz na size-rule doméne s našimi veľkosťami, ktorého stránka
    // nevráti čitateľný zoznam veľkostí (`parseSizeAvailability`→`null`), zapíše
    // plošný `''` riadok (`else` vetva nižšie) a bude sa preto preverovať KAŽDÝ
    // beh — vedomý konzervatívny kompromis (radšej znova preveriť možno-zastaraný
    // plošný riadok, než cacheovať možno-nesprávny), nie caching bug.
    if (
      hasSizeAvailabilityRule(hostOf(link)) &&
      (ourSizesByLink.get(link) ?? []).length > 0 &&
      rows.some((row) => row.sizeLabel === "")
    ) {
      return false;
    }
    return rows.every((row) => isFresh(row, now));
  };

  const counts = { available: 0, unavailable: 0, unknown: 0, failed: 0 };
  const hosts = new Set<string>();
  const lastFetchByHost = new Map<string, number>();
  const hostStats = new Map<string, { requests: number; enumerationRequests: number; firstAt: number; lastAt: number }>();
  let skipped = 0;
  let checked = 0;

  // Slušnosť + štatistika: pauza sa počíta od POSLEDNEJ požiadavky na TÚ ISTÚ
  // doménu (striedanie domén tak nie je trestané), každý request sa započíta do
  // `hostStats` (base aj enumeračný) pre `job_run.detail` (issue 552).
  const fetchWithDelay = async (url: string, isEnumeration: boolean): Promise<Awaited<ReturnType<PageFetcher>>> => {
    const h = hostOf(url);
    const last = lastFetchByHost.get(h);
    if (last !== undefined) {
      const waitMs = PER_HOST_DELAY_MS - (Date.now() - last);
      if (waitMs > 0) await sleep(waitMs);
    }
    const startedAt = Date.now();
    const result = await fetchPage(url);
    const finishedAt = Date.now();
    lastFetchByHost.set(h, finishedAt);
    const stat = hostStats.get(h) ?? { requests: 0, enumerationRequests: 0, firstAt: startedAt, lastAt: finishedAt };
    stat.requests += 1;
    if (isEnumeration) stat.enumerationRequests += 1;
    stat.firstAt = Math.min(stat.firstAt, startedAt);
    stat.lastAt = Math.max(stat.lastAt, finishedAt);
    hostStats.set(h, stat);
    return result;
  };

  for (const link of links) {
    const host = hostOf(link);
    hosts.add(host);
    if (isLinkFresh(link)) {
      skipped += 1;
      continue;
    }
    if (options.limit !== undefined && checked >= options.limit) {
      skipped += 1;
      continue;
    }

    const fetched = await fetchWithDelay(link, false);
    checked += 1;

    if (!fetched.ok) {
      counts.failed += 1;
      // Zlyhaná kontrola vymaže PRÍPADNÉ predošlé per-veľkostné riadky tejto
      // linky a nahradí ich jediným blanket "neviem" riadkom (rovnaká
      // filozofia ako pôvodný jednoriadkový model — `ok=false` samo osebe
      // vylučuje kandidatúru v `restock/queries.ts` bez ohľadu na
      // dostupnosť, takže to nič neoslabuje). Nasledujúci ÚSPEŠNÝ beh riadky
      // po veľkostiach znova odvodí.
      await writeSupplierStockRows(db, {
        link,
        host,
        now,
        ok: false,
        error: fetched.error,
        httpStatus: fetched.httpStatus,
        rows: [{ sizeLabel: "", availability: "unknown", availabilityText: "", price: null, source: "none" }],
      });
      continue;
    }

    const ourSizes = ourSizesByLink.get(link) ?? [];
    // Base kombinácia (predvolená, z prípony odkazu) — JSON-LD krížová kontrola
    // ostáva len tu (`parseSizeAvailability`→`wetlandSizeList`).
    let sizeList = parseSizeAvailability(fetched.html, link);

    // issue 552: enumerácia VŠETKÝCH veľkostí. Host s enumeračným pravidlom a
    // našimi veľkosťami: z bázovej stránky sa poskladajú `action=refresh`
    // GET-y per veľkosť (ten istý fetch klient + per-host delay), odpovede sa
    // rozbalia a zlúčia s bázovou kombináciou (dedup podľa názvu). Produkt bez
    // veľkostného <select>u (jednoveľkostný) → `targets` prázdne → padne na
    // plošný riadok fázy 1 (nezmenené).
    const enumerator = ourSizes.length > 0 ? sizeCombinationEnumeratorFor(link) : null;
    if (enumerator !== null) {
      const targets = enumerator.targets(fetched.html, link);
      if (targets.length > 0) {
        const mismatch = enumerator.suffixMismatch?.(fetched.html, link) ?? null;
        if (mismatch !== null) {
          log.warn(
            { link, suffixIpa: mismatch.expected, fetchedIpa: mismatch.actual },
            "Dodávateľský sklad: zastaraná prípona odkazu (301 na predvolenú kombináciu), enumerujem zo selectu",
          );
        }
        const merged: SizeAvailability[] = [...(sizeList ?? [])];
        for (const target of targets) {
          const comboFetched = await fetchWithDelay(target.url, true);
          if (!comboFetched.ok) continue; // zlyhaná veľkosť sa preskočí, ostatné sa aj tak zapíšu
          merged.push(...parseCombinationResponse(comboFetched.html, link));
        }
        sizeList = mergeSizeAvailability(merged);
        log.info(
          { link, enumerationRequests: targets.length, sizes: sizeList.length },
          "Dodávateľský sklad: enumerácia veľkostí wetland.sk",
        );
      }
    }

    const rows = buildSizeStockRows({
      ourSizes,
      sizeList,
      hostHasSizeRule: hasSizeAvailabilityRule(host),
      page: parsePage(fetched.html, link),
    });

    for (const row of rows) counts[row.availability] += 1;
    await writeSupplierStockRows(db, {
      link,
      host,
      now,
      ok: true,
      error: null,
      httpStatus: fetched.httpStatus,
      rows,
    });
  }

  return {
    total: links.length,
    skipped,
    checked,
    available: counts.available,
    unavailable: counts.unavailable,
    unknown: counts.unknown,
    failed: counts.failed,
    hosts: [...hosts].sort((a, b) => a.localeCompare(b)),
    hostStats: [...hostStats.entries()]
      .map(([host, s]) => ({
        host,
        requests: s.requests,
        enumerationRequests: s.enumerationRequests,
        elapsedMs: s.lastAt - s.firstAt,
      }))
      .sort((a, b) => a.host.localeCompare(b.host)),
  };
}

type SupplierStockInsert = typeof supplierStock.$inferInsert;

// `Pick<Database, "insert" | "delete">` (nie celý `Database`) — rovnaký vzor
// ako `audit/service.ts`'s `AuditExecutor` (`.claude/rules/database.md`):
// `tx` z `db.transaction(async (tx) => ...)` má `PgTransaction`, ktorý má
// `.insert()`/`.delete()` rovnakého tvaru, ale chýba mu `Database`'s vlastné
// `$client`, takže by ho `tsc` odmietol ako argument typu `Database`.
type SupplierStockWriter = Pick<Database, "insert" | "delete">;

/**
 * Zapíše VŠETKY riadky tejto linky pre tento beh a vymaže zvyšné (issue 224)
 * — inak by po zmene stratégie (napr. produkt medzičasom dostal viac
 * veľkostí, alebo naopak) ostal v tabuľke zavádzajúci riadok z predošlého
 * behu, ktorý by `restock/queries.ts`'s JOIN mohol nesprávne spárovať s
 * iným variantom (fallback na `size_label=''`). Mazanie + zápisy bežia v
 * JEDNEJ transakcii (code review, issue 224) — inak by prerušený beh (pád
 * procesu) mohol nechať linku len s ČASŤOU jej veľkostí zapísanou; taká
 * čiastočná množina by `isLinkFresh` vyhodnotil ako "čerstvá" (všetky
 * PRÍTOMNÉ riadky sú fresh) a chýbajúce veľkosti by sa neskúsili znova až do
 * vypršania `MAX_AGE_HOURS`.
 */
async function writeSupplierStockRows(
  db: Database,
  args: {
    readonly link: string;
    readonly host: string;
    readonly now: Date;
    readonly ok: boolean;
    readonly error: string | null;
    readonly httpStatus: number | null;
    readonly rows: readonly StockRowInput[];
  },
): Promise<void> {
  const { link, host, now, ok, error, httpStatus, rows } = args;
  const wantedSizes = rows.map((r) => r.sizeLabel);
  await db.transaction(async (tx) => {
    await tx.delete(supplierStock).where(and(eq(supplierStock.link, link), notInArray(supplierStock.sizeLabel, wantedSizes)));
    for (const row of rows) {
      await upsert(tx, {
        link,
        sizeLabel: row.sizeLabel,
        host,
        availability: row.availability,
        availabilityText: row.availabilityText,
        price: row.price === null ? null : row.price.toFixed(2),
        source: row.source,
        ok,
        error,
        httpStatus,
        checkedAt: now,
        // Iba SKUTOČNE určená dostupnosť je potvrdenie. `unknown` znamená
        // „stránka sa načítala, ale nič sme sa nedozvedeli" — to nesmie
        // predlžovať platnosť predošlého „skladom". Zlyhaná kontrola (ok=false)
        // rovnako nikdy nepotvrdzuje.
        confirmedAt: ok && row.availability !== "unknown" ? now : null,
      });
    }
  });
}

async function upsert(db: SupplierStockWriter, row: SupplierStockInsert): Promise<void> {
  await db
    .insert(supplierStock)
    .values(row)
    .onConflictDoUpdate({
      target: [supplierStock.link, supplierStock.sizeLabel],
      set: {
        host: row.host,
        availability: row.availability,
        availabilityText: row.availabilityText,
        price: row.price,
        source: row.source,
        ok: row.ok,
        error: row.error,
        httpStatus: row.httpStatus,
        checkedAt: row.checkedAt,
        // `confirmedAt` sa pri zlyhaní/`unknown` NEPREPÍŠE na `null` —
        // predošlé potvrdenie si má dožiť svoju 48-hodinovú platnosť
        // (issue 213), nie zmiznúť pri prvom výpadku siete.
        ...(row.confirmedAt === null ? {} : { confirmedAt: row.confirmedAt }),
      },
    });
}
