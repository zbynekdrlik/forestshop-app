import { and, count, eq, isNull, lt, ne, or } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairingDecisions, pairingVariantLinks, productSupplierLinkOverrides, variants } from "../../db/schema.js";
import { log } from "../../logger.js";
import type { WritebackRow } from "./csv.js";

export interface SelectedWriteback {
  /** productKey of every changed override that owns at least one variant —
   * used to mark `syncedAt` after a CONFIRMED successful import
   * (run-writeback.ts). Includes a fully-split product (0 emitted rows, its
   * override dormant/covered by per-size links) so it never re-selects
   * forever; excludes only the true "no variant at all" data anomaly. */
  readonly productKeys: readonly string[];
  /** one row per NON-split-governed variant of every changed product, ready
   * for buildWritebackCsv. Split-governed variants (a per-size link AND
   * `pairing_decision.status='split'`) are excluded here — their internalNote
   * is owned by `select-variant-links.ts` (issue 423). */
  readonly rows: readonly WritebackRow[];
}

/**
 * "Zmenilo sa niečo od posledného úspešného zápisu?" (issue 122) — nikdy
 * celý katalóg. `syncedAt IS NULL` = ešte nikdy odoslané; `syncedAt <
 * updatedAt` = odoslané, ale odvtedy znova upravené (ďalšia úprava po
 * predchádzajúcom syncu). Vracia jeden CSV riadok PER VARIANT patriaci
 * danému produktu — `internalNote` (odkaz na dodávateľa) je produktové pole,
 * ale Shoptet páruje import podľa variantového `code`+`pairCode`
 * (`parovanie_produktov`'s `link_rows`, viď design komentár na #122).
 *
 * issue 423 — split-riadené varianty (majú `pairing_variant_link` A ich
 * produkt má `pairing_decision.status = 'split'`) sú z produktovej cesty
 * VYLÚČENÉ: ich internalNote vlastní `pairing_variant_link`, píše ho
 * `select-variant-links.ts` cez zlúčený import. Bez tohto vylúčenia by
 * produktový override prepísal internalNote split veľkosti — a keby bol
 * override zmenený, vyprodukoval by DUPLICITNÝ kód popri per-veľkosť ceste
 * (Shoptet zruší CELÝ import pri duplicitnom kóde). Vylúčenie robí kódy
 * oboch ciest DISJUNKTNÉ konštrukčne.
 */
export async function selectChangedSupplierLinks(db: Database): Promise<SelectedWriteback> {
  const changedCondition = or(
    isNull(productSupplierLinkOverrides.syncedAt),
    lt(productSupplierLinkOverrides.syncedAt, productSupplierLinkOverrides.updatedAt),
  );

  const rows = await db
    .select({
      code: variants.code,
      pairCode: variants.pairCode,
      internalNote: productSupplierLinkOverrides.url,
      productKey: productSupplierLinkOverrides.productKey,
    })
    .from(productSupplierLinkOverrides)
    .innerJoin(variants, eq(variants.productKey, productSupplierLinkOverrides.productKey))
    // issue 423: `pairing_variant_link` per variantovom `code`,
    // `pairing_decision` per produkte — spolu určujú, či je variant
    // split-riadený (a teda vylúčený z produktovej cesty). LEFT JOINy
    // (nie inner) — variant BEZ per-veľkosť linku / BEZ rozhodnutia ostáva.
    .leftJoin(pairingVariantLinks, eq(pairingVariantLinks.code, variants.code))
    .leftJoin(pairingDecisions, eq(pairingDecisions.productKey, productSupplierLinkOverrides.productKey))
    .where(
      and(
        changedCondition,
        // issue 465: variant zmiznutý zo Shoptetu (`missing_since` nastavené
        // katalógovým importom — variant sa nikdy nemaže, len značí) sa do CSV
        // NIKDY neposiela. Shoptet import odmietne CELÚ dávku pri kóde, ktorý
        // už nemá (`failed:1`), a `run-writeback.ts` pri zlyhaní neoznačí NIČ →
        // tá istá otrávená dávka sa vyberá donekonečna (173 zlyhaní za sebou),
        // pričom jeden mŕtvy kód blokuje aj zdravé súrodenecké overridy.
        isNull(variants.missingSince),
        // Vylúč variant IBA keď má per-veľkosť link A produkt je split.
        or(
          isNull(pairingVariantLinks.code),
          isNull(pairingDecisions.status),
          ne(pairingDecisions.status, "split"),
        ),
      ),
    );

  // Marking set (issue 423): každý zmenený override, ktorý MÁ aspoň jeden
  // variant, sa smie označiť ako synced — vrátane produktu, ktorého VŠETKY
  // varianty sú split-riadené (0 emitovaných riadkov vyššie, ale jeho
  // override je dormantný, pokrytý per-veľkosť linkami — nesmie donekonečna
  // re-selectovať). Skutočná "anomália bez variantu" (override na productKey
  // s NULA variantmi, dátová anomália z PR 140 review #122) sa NEoznačí a
  // zaloguje ako predtým — jedna GROUP BY otázka pokrýva oboje.
  const overrideVariantCounts = await db
    .select({
      productKey: productSupplierLinkOverrides.productKey,
      variantCount: count(variants.code),
    })
    .from(productSupplierLinkOverrides)
    .leftJoin(variants, eq(variants.productKey, productSupplierLinkOverrides.productKey))
    .where(changedCondition)
    .groupBy(productSupplierLinkOverrides.productKey);

  // issue 465: ktoré zmenené overridy majú aspoň jeden ŽIVÝ (nie
  // `missing_since`) variant — na odlíšenie „všetky veľkosti zmizli zo
  // Shoptetu" (0 živých, ale varianty existujú) od bežného produktu aj od
  // „0 variantov vôbec" anomálie nižšie. Ten istý idiom (innerJoin +
  // isNull(missingSince)) ako riadková otázka vyššie.
  const liveVariantOverrides = await db
    .selectDistinct({ productKey: productSupplierLinkOverrides.productKey })
    .from(productSupplierLinkOverrides)
    .innerJoin(variants, eq(variants.productKey, productSupplierLinkOverrides.productKey))
    .where(and(changedCondition, isNull(variants.missingSince)));
  const withLiveVariant = new Set(liveVariantOverrides.map((r) => r.productKey));

  const productKeys: string[] = [];
  const noVariantAnomaly: string[] = [];
  const allVariantsMissing: string[] = [];
  for (const row of overrideVariantCounts) {
    if (row.variantCount === 0) {
      noVariantAnomaly.push(row.productKey);
      continue;
    }
    // Má aspoň jeden variant → smie sa označiť synced (vrátane fully-split
    // dormantného override z #423 aj all-missing produktu nižšie — oba majú 0
    // emitovaných riadkov, ale VARIANTY existujú), inak by re-selectoval
    // otrávenú dávku donekonečna.
    productKeys.push(row.productKey);
    // issue 465: ...ale ak nemá ANI JEDEN živý variant (všetky `missing_since`),
    // do Shoptetu sa preň nikdy nič nezapíše — označíme synced (nech necyklí),
    // ale ZALOGUJEME (nie tichý drop), aby bolo vidno, že odkaz sa reálne
    // nezapísal. Fully-split dormantný override (#423) má živé varianty (len
    // split-riadené) → tu sa NEoznačí ako all-missing, ostáva tichý.
    if (!withLiveVariant.has(row.productKey)) allVariantsMissing.push(row.productKey);
  }
  if (noVariantAnomaly.length > 0) {
    log.warn(
      { skippedProductKeys: noVariantAnomaly },
      "shoptet write-back: preskočené zmenené odkazy na dodávateľa bez žiadneho variantu (dátová anomália)",
    );
  }
  if (allVariantsMissing.length > 0) {
    log.warn(
      { markedProductKeys: allVariantsMissing },
      "shoptet write-back: zmenený odkaz na dodávateľa, ktorého VŠETKY varianty zmizli zo Shoptetu (missing_since) — označené ako synced (niet čo zapísať), odkaz sa fyzicky nezapísal",
    );
  }

  return {
    productKeys,
    rows: rows.map((r) => ({ code: r.code, pairCode: r.pairCode ?? "", internalNote: r.internalNote })),
  };
}
