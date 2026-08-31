// Výber produktov, ktoré sa smú zapnúť späť na „Skladom" (issue 213).
//
// Toto je najcitlivejšie miesto celej automatizácie: zlý výber zapne na živom
// e-shope produkt, ktorý majiteľ vedome vypol. Preto sa každá podmienka
// kontroluje pozitívne (musí platiť), nikdy sa nič nepredpokladá.

import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairingDecisions, pairingVariantLinks, products, restockEvents, shopProductUrl, supplierStock, variants } from "../../db/schema.js";
import { PREORDER_MARKERS } from "../catalog/availability.js";
import { FEED_IN_STOCK } from "../catalog/feed-cross-check.js";
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
 *  - náš stav je `out_of_stock` (vypredané) ALEBO predobjednávka (issue 526:
 *    `sellable` + `availability_text` obsahuje „Predobjednávka") — už bežne
 *    predajný variant sa neprepína, z čoho plynie idempotencia: po prepnutí na
 *    „Skladom" ho ďalší katalógový import odvodí `sellable` bez predobjednávky,
 *    takže kandidátom prestane byť;
 *  - `product_visibility` je presne `visible` — `detailOnly`/`hidden`/…
 *    je vedomé „nepredávať" a nikdy sa neprebíja;
 *  - variant nechýba z exportu (`missing_since IS NULL`) — zapnúť niečo, čo
 *    Shoptet už nevidí, nedáva zmysel;
 *  - dodávateľská linka má ÚSPEŠNÚ kontrolu (`ok`), dostupnosť `available`
 *    a potvrdenie nie staršie než `CONFIRMATION_MAX_AGE_HOURS`;
 *  - IBA pre VYPREDANÚ vetvu: Shoptetov VLASTNÝ feed pre porovnávače (issue
 *    226) NEHOVORÍ "in stock" — keď feed hlási skladom pre variant, ktorý MY
 *    vedieme ako vypredaný, naše odvodenie je podozrivé (presne trieda chyby z
 *    issue 219) a kandidátom sa nesmie stať, kým sa rozpor nevysvetlí.
 *    Chýbajúci feed riadok (626 viditeľných variantov, issue 220) NIE JE
 *    rozpor — kandidát sa vyberie ako predtým. Pre PREDOBJEDNÁVKU sa tento
 *    guard NEAPLIKUJE (issue 526): sme `sellable`, takže feed „in stock" je
 *    zhoda, nie rozpor — aplikovať ho by ticho zahodilo feedom-„in stock"
 *    predobjednávky.
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
  const productLink = sql<string>`trim(both from regexp_replace(substring(${products.internalNote} from 'https?://[^[:space:]]+'), '[.,;:)\\]]+$', ''))`;
  // issue 423: split-riadený variant (má `pairing_variant_link` A jeho
  // produkt má `pairing_decision.status='split'`) má VLASTNÚ per-veľkosť
  // linku namiesto produktovej. Efektívna linka = per-veľkosť linka pri
  // split produkte, inak produktová — rovnaká trailing-punct normalizácia
  // oboch strán, aby sa kľúč na `supplier_stock` nemohol rozísť s
  // `collectSupplierLinks` scraperom (ktorý split linku scrapuje ako
  // blanket `size_label=''`, čo pod-JOIN nižšie cez `size_label=''` vetvu
  // spáruje). Dormantná per-veľkosť linka (produkt nerozdelený) sa
  // ignoruje — `coalesce` padne na produktovú.
  const variantLink = sql<string>`trim(both from regexp_replace(substring(${pairingVariantLinks.url} from 'https?://[^[:space:]]+'), '[.,;:)\\]]+$', ''))`;
  const link = sql<string>`coalesce(case when ${pairingDecisions.status} = 'split' then ${variantLink} end, ${productLink})`;

  // issue 526: predobjednávkový produkt ostáva `sellable` (zákazník ho smie
  // objednať), ale automatizácia ho má sledovať rovnako ako vypredané. Marker
  // žije v `availability.ts` — jeden zdroj interpretácie textu, aby sa SQL
  // nikdy nerozišlo s odvodením stavu. Match beží na `lower(...)` texte
  // (`availability_text` je `notNull`). `?? sql\`false\`` je fail-closed
  // poistka: keby `PREORDER_MARKERS` bol prázdny, `or(...[])` je v drizzle
  // `undefined` a `and(state='sellable', undefined)` by skolabovalo na holé
  // `state='sellable'` (kandidátom by sa stal KAŽDÝ predajný variant). `false`
  // namiesto toho znamená „žiadny predobjednávkový kandidát", nikdy „všetky".
  const isPreorderText =
    or(...PREORDER_MARKERS.map((marker) => sql`lower(${variants.availabilityText}) like ${`%${marker}%`}`)) ??
    sql`false`;

  // issue 226: krížová kontrola proti Shoptetovmu feedu je relevantná LEN pre
  // vypredanú vetvu — tam je feed „in stock" skutočný rozpor (naše
  // `out_of_stock` odvodenie sa vie mýliť, issue 219). Pre predobjednávku sme
  // `sellable`, takže feed „in stock" je ZHODA (`compareStateToFeed`), nie
  // rozpor — vylúčiť na ňom kandidáta by ticho zahodilo predobjednávky, ktoré
  // Shoptet vo feede hlási ako „in stock" (issue 526 review). Preto sa tento
  // guard aplikuje IBA na `out_of_stock` vetvu nižšie. `IS NULL` musí byť
  // explicitné — `!= 'in stock'` samo o sebe vyhodnotí NULL (žiadny feed
  // riadok) na NULL, čo by WHERE ticho zahodilo.
  const feedNotInStock = or(isNull(shopProductUrl.availability), ne(shopProductUrl.availability, FEED_IN_STOCK));

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
    // issue 423: LEFT JOINy PRED `supplierStock` innerJoinom — jeho ON
    // klauzula (`eq(supplierStock.link, link)`) referencuje `link`, ktorý
    // referencuje tieto dve tabuľky, takže musia byť v JOIN zozname skôr.
    .leftJoin(pairingVariantLinks, eq(pairingVariantLinks.code, variants.code))
    .leftJoin(pairingDecisions, eq(pairingDecisions.productKey, products.key))
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
        // issue 526: kandidátom je vypredaný (`out_of_stock`) ALEBO
        // predobjednávkový (`sellable` + text „Predobjednávka") variant. Kotva
        // `state='sellable'` zaručuje, že jednotlivo vypnutý predobjednávkový
        // variant (už `discontinued`, `availability.ts` kontroluje vypnutie
        // PRED textom) sa nikdy nezapne; `product_visibility='visible'` filter
        // nižšie vylúči `detailOnly`. Idempotencia: po prepnutí je text
        // „Skladom" → LIKE nesedí → variant už nie je kandidátom. Feed-guard
        // (`feedNotInStock`, issue 226) sa aplikuje IBA na vypredanú vetvu —
        // pre predobjednávku je feed „in stock" zhoda, nie rozpor (viď jeho
        // definíciu vyššie).
        or(
          and(eq(variants.state, "out_of_stock"), feedNotInStock),
          and(eq(variants.state, "sellable"), isPreorderText),
        ),
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

export interface RestockEventWithLink {
  readonly id: string;
  readonly at: Date;
  readonly variantCode: string;
  readonly pairCode: string | null;
  readonly productName: string;
  readonly supplier: string | null;
  readonly supplierLink: string;
  readonly supplierAvailabilityText: string;
  readonly supplierPrice: string | null;
  readonly confirmedAt: Date;
  /**
   * Priama adresa detailu NÁŠHO produktu z feedu pre porovnávače (issue 329),
   * alebo `null`, keď kód vo feede nie je (rovnaký LEFT JOIN dôvod ako
   * `RestockCandidate.ourUrl` vyššie — chýbajúci riadok nesmie históriu
   * prepnutí zahodiť).
   */
  readonly ourUrl: string | null;
}

/**
 * História UŽ vykonaných prepnutí (issue 213), teraz aj s odkazom na náš
 * produkt (issue 329) — majiteľ tak vie jedným klikom overiť, či konkrétne
 * prepnutie naozaj sedí, nielen dostať sa k stránke dodávateľa.
 */
export async function listRestockEvents(db: Database, limit: number): Promise<readonly RestockEventWithLink[]> {
  return db
    .select({
      id: restockEvents.id,
      at: restockEvents.at,
      variantCode: restockEvents.variantCode,
      pairCode: restockEvents.pairCode,
      productName: restockEvents.productName,
      supplier: restockEvents.supplier,
      supplierLink: restockEvents.supplierLink,
      supplierAvailabilityText: restockEvents.supplierAvailabilityText,
      supplierPrice: restockEvents.supplierPrice,
      confirmedAt: restockEvents.confirmedAt,
      ourUrl: shopProductUrl.url,
    })
    .from(restockEvents)
    .leftJoin(shopProductUrl, eq(shopProductUrl.code, restockEvents.variantCode))
    .orderBy(desc(restockEvents.at))
    .limit(limit);
}
