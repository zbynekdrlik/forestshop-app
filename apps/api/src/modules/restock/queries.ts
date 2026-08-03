// Výber produktov, ktoré sa smú zapnúť späť na „Skladom" (issue 213).
//
// Toto je najcitlivejšie miesto celej automatizácie: zlý výber zapne na živom
// e-shope produkt, ktorý majiteľ vedome vypol. Preto sa každá podmienka
// kontroluje pozitívne (musí platiť), nikdy sa nič nepredpokladá.

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { products, supplierStock, variants } from "../../db/schema.js";
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
}

export interface RestockCandidates {
  /** Prvých `limit` kandidátov — presne tie, ktoré sa v tomto behu prepnú. */
  readonly picked: readonly RestockCandidate[];
  /** Koľko kandidátov spĺňalo všetko, ale neprešlo cez strop. */
  readonly overLimit: number;
}

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
export async function selectRestockCandidates(
  db: Database,
  now: Date,
  limit = MAX_PER_RUN,
): Promise<RestockCandidates> {
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
    })
    .from(variants)
    .innerJoin(products, eq(variants.productKey, products.key))
    .innerJoin(supplierStock, eq(supplierStock.link, link))
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

  return {
    picked: unique.slice(0, limit),
    overLimit: Math.max(0, unique.length - limit),
  };
}
