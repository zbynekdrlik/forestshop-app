// Výber produktov, ktoré sa smú zapnúť späť na „Skladom" (issue 213).
//
// Toto je najcitlivejšie miesto celej automatizácie: zlý výber zapne na živom
// e-shope produkt, ktorý majiteľ vedome vypol. Preto sa každá podmienka
// kontroluje pozitívne (musí platiť), nikdy sa nič nepredpokladá.

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { products, shopProductUrl, supplierStock, variants } from "../../db/schema.js";
import {
  CONFIRMATION_MAX_AGE_HOURS,
  MAX_PER_RUN,
  SELLABLE_VISIBILITY,
} from "./constants.js";

export interface RestockCandidate {
  readonly variantCode: string;
  readonly pairCode: string | null;
  readonly productName: string;
  readonly supplier: string | null;
  readonly supplierLink: string;
  readonly supplierAvailabilityText: string;
  readonly supplierPrice: string | null;
  readonly confirmedAt: Date;
  /**
   * Priama adresa detailu NÁŠHO produktu z feedu pre porovnávače (issue 220),
   * alebo `null`, keď kód vo feede nie je. `null` NIE JE chyba — 626
   * viditeľných variantov vo feede nie je a tie na obrazovke padnú späť na
   * vyhľadávanie podľa kódu.
   */
  readonly ourUrl: string | null;
}

export interface RestockCandidates {
  /** Prvých `limit` kandidátov — presne tie, ktoré sa v tomto behu prepnú. */
  readonly picked: readonly RestockCandidate[];
  /** Koľko kandidátov spĺňalo všetko, ale neprešlo cez strop. */
  readonly overLimit: number;
}

export interface RestockSupplierCount {
  readonly name: string;
  readonly count: number;
}

export interface RestockWaitingPage {
  /** Koľko kandidátov zostáva po filtri (nie veľkosť stránky). */
  readonly total: number;
  readonly rows: readonly RestockCandidate[];
  /** Dodávatelia s počtami cez CELÝ zoznam, nikdy len cez stránku. */
  readonly suppliers: readonly RestockSupplierCount[];
}

const NO_SUPPLIER_LABEL = "(bez dodávateľa)";

/**
 * Kandidát musí spĺňať VŠETKO naraz:
 *  - náš stav je `out_of_stock` (vypredané) — už predajný variant sa
 *    neprepína, z čoho plynie idempotencia: po prepnutí a ďalšom katalógovom
 *    importe kandidátom nie je;
 *  - `product_visibility` je presne `visible` — `detailOnly`/`hidden`/…
 *    je vedomé „nepredávať" a nikdy sa neprebíja;
 *  - variant nechýba z exportu (`missing_since IS NULL`) — zapnúť niečo, čo
 *    Shoptet už nevidí, nedáva zmysel;
 *  - dodávateľská linka má ÚSPEŠNÚ kontrolu (`ok`), dostupnosť `available`
 *    a potvrdenie nie staršie než `CONFIRMATION_MAX_AGE_HOURS`.
 *
 * `unknown` (stránka sa načítala, ale nič sa z nej nedalo vyčítať) ani
 * zlyhaná kontrola NIKDY neprepnú produkt — to je celý zmysel toho, že sme
 * odmietli AI dohady.
 *
 * Každý `code` sa vráti najviac raz — Shoptet zruší CELÝ import pri
 * duplicitnom kóde a katalóg obsahuje produkty zdieľajúce kódy variantov.
 */
async function allRestockCandidates(db: Database, now: Date): Promise<readonly RestockCandidate[]> {
  const oldestAcceptable = new Date(now.getTime() - CONFIRMATION_MAX_AGE_HOURS * 3_600_000);

  // Linka sa z `internal_note` vyberá TÝM ISTÝM spôsobom ako v scraperi
  // (`supplier-link.ts` → prvý `http(s)://…` výskyt): `substring` s rovnakým
  // vzorom, aby sa kľúč na `supplier_stock` nemohol rozísť. Koncová
  // interpunkcia sa oreže rovnako ako tam.
  const link = sql<string>`trim(both from regexp_replace(substring(${products.internalNote} from 'https?://[^[:space:]]+'), '[.,;:)\\]]+$', ''))`;

  const rows = await db
    .select({
      variantCode: variants.code,
      pairCode: variants.pairCode,
      productName: variants.name,
      supplier: products.supplier,
      supplierLink: supplierStock.link,
      supplierAvailabilityText: supplierStock.availabilityText,
      supplierPrice: supplierStock.price,
      confirmedAt: supplierStock.confirmedAt,
      ourUrl: shopProductUrl.url,
    })
    .from(variants)
    .innerJoin(products, eq(variants.productKey, products.key))
    // issue 224: odkaz s pravidlom na veľkosti nesie VIAC riadkov naraz —
    // jeden na KAŽDÚ našu veľkosť. Variant sa spáruje buď na SVOJU vlastnú
    // veľkosť (`size_label = coalesce(variant.size_label,'')`), alebo na
    // blanket riadok (`size_label = ''`) pre linky bez rozlíšenia veľkosti.
    // Tieto dve vetvy sa pre TEN ISTÝ odkaz nikdy nestretnú naraz — `run.ts`
    // pre každý odkaz zapíše VÝHRADNE jednu z týchto dvoch stratégií a
    // zvyšné riadky vymaže.
    .innerJoin(
      supplierStock,
      and(
        eq(supplierStock.link, link),
        or(
          eq(supplierStock.sizeLabel, sql<string>`coalesce(${variants.sizeLabel}, '')`),
          eq(supplierStock.sizeLabel, ""),
        ),
      ),
    )
    // LEFT zámerne: variant bez záznamu vo feede NESMIE zo zoznamu vypadnúť —
    // majiteľ overuje presne tie riadky, ktoré by sa prepli, takže skrytý
    // riadok by znamenal prepnutie bez kontroly (trieda chyby z issue 219).
    .leftJoin(shopProductUrl, eq(shopProductUrl.code, variants.code))
    .where(
      and(
        eq(variants.state, "out_of_stock"),
        eq(variants.productVisibility, SELLABLE_VISIBILITY),
        isNull(variants.missingSince),
        eq(supplierStock.ok, true),
        eq(supplierStock.availability, "available"),
        sql`${supplierStock.confirmedAt} is not null`,
        sql`${supplierStock.confirmedAt} >= ${oldestAcceptable}`,
        sql`${supplierStock.confirmedAt} <= ${now}`,
      ),
    )
    // Stabilné poradie: najstaršie potvrdenie prvé, potom podľa kódu — pri
    // strope tak nikdy nezostane ten istý variant navždy „na chvoste".
    .orderBy(asc(supplierStock.confirmedAt), asc(variants.code));

  const seen = new Set<string>();
  const unique: RestockCandidate[] = [];
  for (const row of rows) {
    if (seen.has(row.variantCode)) continue;
    if (row.confirmedAt === null) continue;
    seen.add(row.variantCode);
    unique.push({ ...row, confirmedAt: row.confirmedAt });
  }
  return unique;
}

export async function selectRestockCandidates(
  db: Database,
  now: Date,
  limit = MAX_PER_RUN,
): Promise<RestockCandidates> {
  const unique = await allRestockCandidates(db, now);
  return {
    picked: unique.slice(0, limit),
    overLimit: Math.max(0, unique.length - limit),
  };
}

/**
 * Overovací zoznam pre majiteľa (issue 217) — presne tí istí kandidáti, ktorých
 * by prepli nasledujúce behy, len bez stropu a po stránkach.
 *
 * Zámerne stavia na tej istej `allRestockCandidates`, nie na vlastnej kópii
 * podmienok: zoznam, podľa ktorého sa človek rozhoduje, sa nesmie rozísť s tým,
 * čo automatizácia naozaj urobí.
 */
export async function listRestockWaiting(
  db: Database,
  now: Date,
  options: { readonly limit: number; readonly offset: number; readonly supplier?: string },
): Promise<RestockWaitingPage> {
  const unique = await allRestockCandidates(db, now);

  const counts = new Map<string, number>();
  for (const row of unique) {
    const name = row.supplier ?? NO_SUPPLIER_LABEL;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const suppliers = [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "sk"));

  const filtered =
    options.supplier === undefined
      ? unique
      : unique.filter((row) => (row.supplier ?? NO_SUPPLIER_LABEL) === options.supplier);

  return {
    total: filtered.length,
    rows: filtered.slice(options.offset, options.offset + options.limit),
    suppliers,
  };
}
