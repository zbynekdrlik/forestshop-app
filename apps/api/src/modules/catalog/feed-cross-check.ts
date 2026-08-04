// Krížová kontrola nášho odvodeného `variant.state` proti Shoptetovej VLASTNEJ
// dostupnosti z feedu pre porovnávače (issue 226).
//
// `variant.state` je LEN naša dedukcia z CSV textu (`availability.ts`) —
// issue 219 ukázalo, že sa vie rozísť s realitou. Feed nesie Shoptetov
// vlastný, NEZÁVISLÝ úsudok (`<g:availability>`, uložené v
// `shop_product_url.availability` od issue 226) — porovnanie oboch je druhý,
// nezávislý zdroj pravdy.
//
// Zámerne POČÍTANÉ NAŽIVO z aktuálneho stavu DB, nikdy do vlastnej tabuľky:
// `shop_product_url` sa obnovuje DENNE (03:50), katalógový import HODINOVO
// (:20) — perzistovaná snímka rozporov by sa medzi behmi rozišla od reality,
// presne ten istý problém, ktorý sa tu rieši. Rovnaký vzor ako
// `restock/queries.ts`'s `allRestockCandidates`.

import { eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { shopProductUrl, variants } from "../../db/schema.js";
import { log } from "../../logger.js";
import type { VariantState } from "./availability.js";

// Presne tie dve hodnoty, ktoré Shoptet do `<g:availability>` píše (overené
// živým stiahnutím `google.xml` 4. 8. 2026: 7 449× "in stock", 139×
// "out of stock", 91× prázdne — žiadna iná hodnota). Google Merchant feed
// spec pozná aj "preorder"/"backorder" — tie sa berú ako `no_signal`, nikdy
// ako rozpor, presne ako neznámy/prázdny text.
// Exportované (nie `const` súkromná) — `restock/queries.ts` potrebuje TÚ ISTÚ
// hodnotu na vylúčenie kandidátov priamo v SQL WHERE, aby literál nikdy
// nerozišiel od tohto porovnávača.
export const FEED_IN_STOCK = "in stock";
const FEED_OUT_OF_STOCK = "out of stock";

export type FeedComparisonResult = "match" | "mismatch" | "no_signal";

/**
 * `"in stock"` očakáva `sellable`; `"out of stock"` očakáva NIE-`sellable`
 * (`out_of_stock` aj `discontinued` sú z pohľadu zákazníka rovnako
 * nekúpiteľné). Chýbajúci/prázdny/neznámy signál nikdy nič nerozhoduje.
 */
export function compareStateToFeed(
  state: VariantState,
  feedAvailability: string | null,
): FeedComparisonResult {
  const normalized = (feedAvailability ?? "").trim().toLowerCase();
  if (normalized === FEED_IN_STOCK) return state === "sellable" ? "match" : "mismatch";
  if (normalized === FEED_OUT_OF_STOCK) return state === "sellable" ? "mismatch" : "match";
  return "no_signal";
}

export interface FeedStateConflict {
  readonly variantCode: string;
  readonly productName: string;
  readonly ourState: VariantState;
  readonly feedAvailability: string;
  /** Priama adresa z feedu — vždy nenulová (bez feed riadku by tu žiadny rozpor nebol). */
  readonly ourUrl: string;
}

export interface FeedConflictSummary {
  readonly total: number;
  readonly rows: readonly FeedStateConflict[];
}

// Karta na obrazovke je varovanie na ručné preverenie, nie pracovný zoznam —
// strop drží odpoveď v rozumnej veľkosti, aj keby sa (ako pri issue 219)
// odvodenie znova rozišlo naprieč tisíckami variantov naraz.
const MAX_CONFLICT_ROWS = 200;

/**
 * INNER JOIN zámerne — variant bez feed riadku (626 viditeľných, issue 220)
 * sa do výsledku nedostane vôbec, presne ako "nepočíta sa ako rozpor" žiada.
 */
export async function findFeedStateConflicts(db: Pick<Database, "select">): Promise<FeedConflictSummary> {
  const rows = await db
    .select({
      variantCode: variants.code,
      productName: variants.name,
      state: variants.state,
      availability: shopProductUrl.availability,
      url: shopProductUrl.url,
    })
    .from(variants)
    .innerJoin(shopProductUrl, eq(shopProductUrl.code, variants.code))
    .orderBy(sql`${variants.code}`);

  const conflicts: FeedStateConflict[] = [];
  for (const row of rows) {
    if (compareStateToFeed(row.state, row.availability) !== "mismatch") continue;
    conflicts.push({
      variantCode: row.variantCode,
      productName: row.productName,
      ourState: row.state,
      feedAvailability: row.availability ?? "",
      ourUrl: row.url,
    });
  }

  return { total: conflicts.length, rows: conflicts.slice(0, MAX_CONFLICT_ROWS) };
}

/**
 * Voliteľné doplnkové logovanie PO KAŽDOM prijatom katalógovom importe
 * (volané z `ingest.ts`, mimo jeho transakcie) — nikdy nevyhodí, aby chyba
 * tejto čisto diagnostickej funkcie neohrozila už úspešne prijatý import.
 * Obrazovka (`/api/restock`) číta `findFeedStateConflicts` priamo a vždy
 * aktuálne — tento log je len doplnkový, ľahko dohľadateľný záznam.
 */
export async function logFeedConflictsAfterImport(
  db: Pick<Database, "select">,
  snapshotId: string,
): Promise<void> {
  try {
    const conflicts = await findFeedStateConflicts(db);
    log.info(
      { snapshotId, feedConflictCount: conflicts.total },
      "krížová kontrola voči Shoptetovmu feedu po importe",
    );
  } catch (error) {
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    log.error(
      { snapshotId, rawErrorMessage },
      "krížová kontrola voči Shoptetovmu feedu zlyhala — import to neovplyvňuje",
    );
  }
}
