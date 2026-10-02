// Beh scrapera dostupnosti u dodávateľa (issue 212, per veľkosť issue 224).
//
// Sériový, zámerne: 969 z 1 210 riadkov reálneho exportu je JEDNA doména
// (`huntingshop.eu`), takže paralelné sťahovanie by na ňu vyzeralo ako útok.
// Medzi dvomi požiadavkami na tú istú doménu je pauza (`PER_HOST_DELAY_MS`).

import { and, eq, like, notInArray, or } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { supplierStock } from "../../db/schema.js";
import { log } from "../../logger.js";
import { MAX_AGE_HOURS, OWN_SHOP_HOST, PER_HOST_DELAY_MS, SUPPLIER_STOCK_RUN_LOCK_KEY } from "./constants.js";
import { collectOurSizesByLink, collectSupplierLinks } from "./links.js";
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
  selectEnumerationTargets,
  type SizeAvailability,
  sizeCombinationEnumeratorFor,
  sizeStructureErrorFor,
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
  /** issue 561: koľko enumeračných cieľov sa PREDFILTROVALO (dodávateľove
   * veľkosti, ktoré NEMÁME) a teda sa nestiahli — priama miera úspory
   * requestov predfiltra. */
  readonly enumerationSkipped: number;
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
 * Štyri cesty:
 *  1. `sizeList` čitateľný + máme veľkosti → per-veľkosť riadok. Priama zhoda
 *     (`matchSizeLabel`); ak zlyhá, PÁROVÝ štítok sa zloží z jednotlivých čísel
 *     dodávateľa (`foldMultiTokenSizeAvailability`, issue 558 A). Bez zhody →
 *     `unknown`/`none`.
 *  2. `sizeList` === null na doméne so SIZE pravidlom a držíme >1 veľkosť →
 *     per-veľkosť `unknown` NAMIESTO plošného riadku (issue 558 B). Plošný `''`
 *     riadok by sa cez `size_label=''` JOIN (`restock/queries.ts`) spároval s
 *     KAŽDOU našou veľkosťou — presne ten over-match, aký issue 551 rieši pre
 *     wetland; per-veľkosť `unknown` nič neprepne (kandidát vyžaduje `available`).
 *  3. `sizeList` vymenúva ≥2 veľkosti, no pre odkaz nemáme ŽIADNU svoju (variant
 *     bez veľkosti, split odkaz) → plošný `unknown` (issue 585): štítok/JSON-LD
 *     stránky hovorí o jednej predvolenej veľkosti, nie o celom produkte.
 *  4. inak (host bez SIZE pravidla, alebo ≤1 veľkosť) → plošný riadok z
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
  if (!perSize && sizeList !== null && sizeList.length > 1) {
    // issue 585 (code review): stránka vymenúva ≥2 veľkosti, no my pre odkaz
    // nepoznáme žiadnu svoju (variant bez veľkosti, split odkaz) — štítok/JSON-LD
    // stránky hovorí len o JEDNEJ (predvolenej) veľkosti, nikdy o celom produkte.
    return [{ sizeLabel: "", availability: "unknown", availabilityText: "", price: page.price, source: "none" }];
  }
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
  const hostStats = new Map<
    string,
    { requests: number; enumerationRequests: number; enumerationSkipped: number; firstAt: number; lastAt: number }
  >();
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
    const stat = hostStats.get(h) ?? { requests: 0, enumerationRequests: 0, enumerationSkipped: 0, firstAt: startedAt, lastAt: finishedAt };
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

    // issue 585: stránka sa stiahla, ale per-veľkosť pravidlo hosta jej
    // štruktúre NEROZUMIE (zmenený markup) → zlyhaná kontrola, nikdy plošné
    // „skladom" zo štítku pri cene.
    const structureError = fetched.ok ? sizeStructureErrorFor(fetched.html, link) : null;
    if (structureError !== null) {
      log.warn({ link, host, reason: structureError }, "Dodávateľský sklad: nerozumiem štruktúre stránky, zapisujem chybový riadok");
    }

    if (!fetched.ok || structureError !== null) {
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
        error: structureError ?? fetched.error,
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
      // issue 561: predfilter na NAŠE veľkosti — dodávateľove veľkosti, ktoré
      // nemáme, sa nesťahujú (wetland: ~82 % requestov bolo zbytočných).
      const allTargets = enumerator.targets(fetched.html, link);
      const targets = selectEnumerationTargets(allTargets, ourSizes);
      const enumerationSkipped = allTargets.length - targets.length;
      if (enumerationSkipped > 0) {
        const hostStat = hostStats.get(host);
        if (hostStat !== undefined) hostStat.enumerationSkipped += enumerationSkipped;
      }
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
          { link, enumerationRequests: targets.length, enumerationSkipped, sizes: sizeList.length },
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
        enumerationSkipped: s.enumerationSkipped,
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
