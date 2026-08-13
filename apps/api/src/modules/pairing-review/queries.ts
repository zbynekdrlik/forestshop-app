// issue 387 E5: "Eshop → Párovanie" — čítacia obrazovka nad tým, čo E3
// (gather) + E4 (verify) už zozbierali a overili. Populácia je "produkty S
// KANDIDÁTMI" (INNER JOIN na `pairing_candidate_set` — produkt, ktorý gather
// ešte nespracoval, sa tu nezobrazuje vôbec, presne ako zadanie žiada).
//
// issue 387 E6: `pairing_decision` (E5's forward-kompat poznámka) teraz
// EXISTUJE — "unreviewed" ostáva PRIMÁRNE "bez efektívnej linky" (E5's
// doslovná zhoda so zadaním), ĎALEJ ZÚŽENÉ o produkty, čo už dostali
// TERMINÁLNE rozhodnutie (`unavailable`/`discontinued` — tie linku NIKDY
// nedostanú, ale SÚ zrevidované, netreba na ne ďalej upozorňovať). Design
// komentár na tickete (issue 387 E6): API kontrakt sa nemení, len sa
// definícia SPRESŇUJE. Rovnaký MVP vzor ako `product-links/queries.ts`/
// `restock-links/queries.ts`/`pairing-search/select.ts` — celá relevantná
// populácia (rádovo stovky, nie celý katalóg) sa načíta a filtruje/triedi/
// stránkuje v JS, keďže `resolveEffectiveSupplierLink` je čistá JS funkcia
// nad `internalNote`, nedá sa vyjadriť ako SQL predikát bez duplicity.

import { eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  pairingCandidates,
  pairingCandidateSets,
  pairingDecisions,
  productSupplierLinkOverrides,
  products,
  shopProductUrl,
  variants,
} from "../../db/schema.js";
import { resolveEffectiveSupplierLink } from "../orders/effective-supplier-link.js";
import type { PairingConfidence, PairingVerdict } from "../pairing-search/types.js";
import { SELLABLE_VISIBILITY } from "../restock/constants.js";
import type { PairingDecisionStatus } from "./decisions.js";

export type PairingReviewFilter = "unreviewed" | "matched" | "unmatched" | "st1" | "st2" | "st3" | "all";
export type PairingReviewProductState = "sellable" | "out_of_stock" | "discontinued";

// Fallback presne ako stará appka (`webreview/app.js`'s `renderCard`) — keď
// appka nepozná priamy odkaz z feedu (issue 220's `shop_product_url`),
// ponúkne aspoň vyhľadávanie podľa mena na vlastnom e-shope.
const OWN_SHOP_SEARCH_BASE = "https://www.forestshop.sk/vyhladavanie/?string=";

export interface PairingReviewChosenCandidate {
  readonly name: string;
  readonly url: string;
  /** issue 397 — obrázok kandidáta (z adaptéra, alebo `verify.ts`'s
   *  `og:image` fallback), `null` keď žiadny zdroj neposkytol použiteľný. */
  readonly imageUrl: string | null;
  readonly rawScore: number;
  readonly codeHit: boolean;
}

// issue 387 E6 — posledné (jediné, appka nedrží históriu) rozhodnutie o
// produkte, `null` = nezrevidované vôbec. Karta ho potrebuje na vykreslenie
// odznaku/panelu "↩ Vrátiť"/"Zmeniť" bez ďalšieho volania.
export interface PairingReviewDecision {
  readonly status: PairingDecisionStatus;
  readonly url: string | null;
  readonly decidedAt: string;
}

export interface PairingReviewItem {
  readonly productKey: string;
  readonly productName: string;
  readonly supplier: string | null;
  readonly externalCodes: readonly string[];
  readonly variantCount: number;
  /** Rollup `variant.state` na produkt — pozri `rollupProductState` nižšie. */
  readonly productState: PairingReviewProductState;
  readonly priceMin: string | null;
  readonly priceMax: string | null;
  readonly currency: string | null;
  /** Nikdy `null` — padá na `OWN_SHOP_SEARCH_BASE` fallback, presne ako stará appka. */
  readonly ourUrl: string;
  /** issue 402: `true` = `ourUrl` je LEN vyhľadávací fallback (žiadny riadok v `shop_product_url`), nie priamy odkaz na produkt — karta ho vizuálne odlíši. */
  readonly ourUrlIsSearchFallback: boolean;
  readonly ourImageUrl: string | null;
  /** `true` = appka už pozná EFEKTÍVNU dodávateľskú linku (override alebo
   * extrahovaná z `internalNote`) — toto JE "unreviewed" predikát (viď hlavička súboru). */
  readonly hasEffectiveLink: boolean;
  readonly gatheredAt: string;
  readonly confidence: PairingConfidence;
  readonly chosenReason: string | null;
  readonly verdict: PairingVerdict | null;
  /** `null` presne keď `confidence === "none"` (gather nenašiel u dodávateľa nič). */
  readonly chosenCandidate: PairingReviewChosenCandidate | null;
  /** issue 387 E6 — posledné rozhodnutie, `null` = nezrevidované vôbec (viď `PairingReviewDecision`). */
  readonly decision: PairingReviewDecision | null;
}

export interface PairingReviewSearchInput {
  readonly filter: PairingReviewFilter;
  readonly page: number;
  readonly pageSize: number;
}

export interface PairingReviewSearchResult {
  readonly total: number;
  /** Celá gather populácia (počet `pairing_candidate_set` riadkov), nezávisle
   * od `filter` — menovateľ pre progress. */
  readonly gatheredTotal: number;
  /** Koľko z `gatheredTotal` už MÁ efektívnu linku — čitateľ pre progress
   * (doplnok `unreviewed` počtu, ktorý číta rovnaký endpoint s `filter=unreviewed`). */
  readonly linkedTotal: number;
  readonly items: readonly PairingReviewItem[];
}

interface VariantRow {
  readonly productKey: string;
  readonly code: string;
  readonly externalCode: string | null;
  readonly state: PairingReviewProductState;
  readonly productVisibility: string;
  readonly missingSince: Date | null;
  readonly price: string | null;
  readonly currency: string | null;
}

/** Nejaký variant `sellable` → Skladom; inak nejaký `out_of_stock` a VIDITEĽNÝ
 * (rovnaká podmienka ako `pairing-search/select.ts`'s `soldOutVisible`) →
 * Nie je skladom; inak → Už sa nebude predávať. `detailOnly` samo osebe nie
 * je "vypnuté" (`.claude/rules/catalog.md`'s `availability.ts` pravidlo) —
 * zachytené tým, že len `out_of_stock` + `SELLABLE_VISIBILITY` počíta ako
 * "Nie je skladom", nikdy len `out_of_stock`. Produkt bez VARIANTOV vôbec
 * (teoreticky nemožné — katalógový import ich vždy páruje) padá na "Už sa
 * nebude predávať", nikdy nevyhodí. */
function rollupProductState(rows: readonly VariantRow[]): PairingReviewProductState {
  if (rows.some((r) => r.state === "sellable")) return "sellable";
  if (rows.some((r) => r.state === "out_of_stock" && r.productVisibility === SELLABLE_VISIBILITY && r.missingSince === null)) {
    return "out_of_stock";
  }
  return "discontinued";
}

export async function listPairingReview(db: Database, input: PairingReviewSearchInput): Promise<PairingReviewSearchResult> {
  const setRows = await db
    .select({
      productKey: pairingCandidateSets.productKey,
      gatheredAt: pairingCandidateSets.gatheredAt,
      chosenUrl: pairingCandidateSets.chosenUrl,
      chosenReason: pairingCandidateSets.chosenReason,
      confidence: pairingCandidateSets.confidence,
      verdict: pairingCandidateSets.verdict,
    })
    .from(pairingCandidateSets);
  if (setRows.length === 0) return { total: 0, gatheredTotal: 0, linkedTotal: 0, items: [] };

  const productKeys = setRows.map((r) => r.productKey);

  const productRows = await db
    .select({ key: products.key, name: products.name, supplier: products.supplier, internalNote: products.internalNote })
    .from(products)
    .where(inArray(products.key, productKeys));
  const productByKey = new Map(productRows.map((r) => [r.key, r]));

  const overrideRows = await db
    .select({ productKey: productSupplierLinkOverrides.productKey, url: productSupplierLinkOverrides.url })
    .from(productSupplierLinkOverrides)
    .where(inArray(productSupplierLinkOverrides.productKey, productKeys));
  const overrideByProduct = new Map(overrideRows.map((r) => [r.productKey, r.url]));

  const variantRows: VariantRow[] = await db
    .select({
      productKey: variants.productKey,
      code: variants.code,
      externalCode: variants.externalCode,
      state: variants.state,
      productVisibility: variants.productVisibility,
      missingSince: variants.missingSince,
      price: variants.price,
      currency: variants.currency,
    })
    .from(variants)
    .where(inArray(variants.productKey, productKeys));
  const variantsByProduct = new Map<string, VariantRow[]>();
  for (const row of variantRows) {
    const bucket = variantsByProduct.get(row.productKey);
    if (bucket === undefined) variantsByProduct.set(row.productKey, [row]);
    else bucket.push(row);
  }

  const variantCodes = variantRows.map((r) => r.code);
  const feedRows =
    variantCodes.length === 0
      ? []
      : await db
          .select({ code: shopProductUrl.code, url: shopProductUrl.url, imageUrl: shopProductUrl.imageUrl })
          .from(shopProductUrl)
          .where(inArray(shopProductUrl.code, variantCodes));
  const feedByCode = new Map(feedRows.map((r) => [r.code, r]));

  const candidateRows = await db
    .select({
      productKey: pairingCandidates.productKey,
      name: pairingCandidates.name,
      url: pairingCandidates.url,
      imageUrl: pairingCandidates.imageUrl,
      rawScore: pairingCandidates.rawScore,
      codeHit: pairingCandidates.codeHit,
    })
    .from(pairingCandidates)
    .where(inArray(pairingCandidates.productKey, productKeys));
  // Kľúčované (productKey, url) — presne dvojica, čo `pairing_candidate`'s
  // vlastný `UNIQUE(product_key, url)` index vynucuje, takže zhoda je vždy
  // jednoznačná. Len kandidát rovný `chosenUrl` sa naozaj vyhľadá nižšie
  // (E5 ukazuje LEN navrhnutého kandidáta, nie všetkých top-8 — design komentár).
  const candidateByKey = new Map(candidateRows.map((r) => [`${r.productKey} ${r.url}`, r]));

  // issue 387 E6 — posledné rozhodnutie na produkt, `undefined` keď žiadne.
  // Samostatný dopyt + Mapa (nie SQL JOIN), rovnaký MVP vzor ako každý iný
  // spájaný zdroj v tejto funkcii — appka vždy spája v JS, nikdy v SQL, keď
  // ide o odvodenú/filtrovanú obrazovkovú logiku (hlavička súboru).
  const decisionRows = await db
    .select({
      productKey: pairingDecisions.productKey,
      status: pairingDecisions.status,
      url: pairingDecisions.url,
      decidedAt: pairingDecisions.decidedAt,
    })
    .from(pairingDecisions)
    .where(inArray(pairingDecisions.productKey, productKeys));
  const decisionByProduct = new Map(decisionRows.map((r) => [r.productKey, r]));

  const allItems: PairingReviewItem[] = [];
  for (const set of setRows) {
    const product = productByKey.get(set.productKey);
    // Osirotený `pairing_candidate_set` riadok (produkt medzičasom zmizol z
    // katalógu) — nikdy sa nezobrazí, rovnaká disciplína ako `select.ts`'s
    // review-nález o `missingSince` (informačná poznámka, nie porušenie).
    if (product === undefined) continue;

    const productVariants = variantsByProduct.get(set.productKey) ?? [];

    const seenCodes = new Set<string>();
    const externalCodes: string[] = [];
    for (const v of productVariants) {
      const code = v.externalCode?.trim();
      if (code !== undefined && code !== "" && !seenCodes.has(code)) {
        seenCodes.add(code);
        externalCodes.push(code);
      }
    }

    let ourUrl: string | null = null;
    let ourImageUrl: string | null = null;
    // Deterministické poradie (najmenší kód vyhráva), rovnaký princíp ako
    // `resolve-products.ts`'s `orderBy(shopProductUrl.code)` pri viacerých zhodách.
    for (const v of [...productVariants].sort((a, b) => a.code.localeCompare(b.code))) {
      const hit = feedByCode.get(v.code);
      if (hit !== undefined) {
        ourUrl = hit.url;
        ourImageUrl = hit.imageUrl;
        break;
      }
    }
    // issue 402: majiteľ reagoval na to, že tento fallback vyzerá ako priamy
    // odkaz na produkt, hoci v skutočnosti otvorí vyhľadávanie — karta ho
    // teraz vizuálne odlíši (`PairingReviewCard.tsx`), preto potrebuje
    // explicitný signál, nie odhad z tvaru URL na frontende.
    const ourUrlIsSearchFallback = ourUrl === null;
    if (ourUrl === null) ourUrl = OWN_SHOP_SEARCH_BASE + encodeURIComponent(product.name);

    const prices = productVariants
      .map((v) => v.price)
      .filter((p): p is string => p !== null)
      .map(Number)
      .filter((n) => Number.isFinite(n));
    const priceMin = prices.length > 0 ? Math.min(...prices).toFixed(2) : null;
    const priceMax = prices.length > 0 ? Math.max(...prices).toFixed(2) : null;
    const currency = productVariants.find((v) => v.currency !== null)?.currency ?? null;

    const effective = resolveEffectiveSupplierLink(product.internalNote, overrideByProduct.get(set.productKey) ?? null);

    const chosenCandidateRow = set.chosenUrl === null ? undefined : candidateByKey.get(`${set.productKey} ${set.chosenUrl}`);
    const chosenCandidate: PairingReviewChosenCandidate | null =
      chosenCandidateRow === undefined
        ? null
        : {
            name: chosenCandidateRow.name,
            url: chosenCandidateRow.url,
            imageUrl: chosenCandidateRow.imageUrl,
            rawScore: Number(chosenCandidateRow.rawScore),
            codeHit: chosenCandidateRow.codeHit,
          };

    const decisionRow = decisionByProduct.get(set.productKey);
    const decision: PairingReviewDecision | null =
      decisionRow === undefined ? null : { status: decisionRow.status, url: decisionRow.url, decidedAt: decisionRow.decidedAt.toISOString() };

    allItems.push({
      productKey: set.productKey,
      productName: product.name,
      supplier: product.supplier,
      externalCodes,
      variantCount: productVariants.length,
      productState: rollupProductState(productVariants),
      priceMin,
      priceMax,
      currency,
      ourUrl,
      ourUrlIsSearchFallback,
      ourImageUrl,
      hasEffectiveLink: effective.url !== null,
      gatheredAt: set.gatheredAt.toISOString(),
      confidence: set.confidence,
      chosenReason: set.chosenReason,
      verdict: set.verdict,
      chosenCandidate,
      decision,
    });
  }

  const gatheredTotal = allItems.length;
  const linkedTotal = allItems.filter((item) => item.hasEffectiveLink).length;

  // issue 387 E6 — "unreviewed" (design komentár na tickete): bez efektívnej
  // linky A bez TERMINÁLNEHO rozhodnutia (unavailable/discontinued nikdy
  // nedostanú linku, ale SÚ zrevidované — netreba na ne ďalej upozorňovať).
  // `good`/`manual` rozhodnutia VŽDY produkujú `hasEffectiveLink === true`
  // (zdieľaný zápis vždy nastaví override), takže pre ne je táto podmienka
  // redundantná s prvou časťou — ponechaná explicitne pre čitateľnosť.
  function isUnreviewed(item: PairingReviewItem): boolean {
    if (item.hasEffectiveLink) return false;
    if (item.decision !== null && (item.decision.status === "unavailable" || item.decision.status === "discontinued")) return false;
    return true;
  }

  const filtered = allItems.filter((item) => {
    switch (input.filter) {
      case "unreviewed":
        return isUnreviewed(item);
      case "matched":
        return item.chosenCandidate !== null;
      case "unmatched":
        return item.chosenCandidate === null;
      case "st1":
        return item.productState === "sellable";
      case "st2":
        return item.productState === "out_of_stock";
      case "st3":
        return item.productState === "discontinued";
      case "all":
        return true;
    }
  });

  // Unmatched-last (design komentár, zadanie bod 3): napárované PRED
  // nenapárovanými, sekundárne meno (sk locale) — rovnaký vzor ako
  // `product-links`/`restock-links`.
  filtered.sort((a, b) => {
    const matchedOrder = Number(a.chosenCandidate === null) - Number(b.chosenCandidate === null);
    if (matchedOrder !== 0) return matchedOrder;
    return a.productName.localeCompare(b.productName, "sk");
  });

  const total = filtered.length;
  const start = (input.page - 1) * input.pageSize;
  const items = filtered.slice(start, start + input.pageSize);

  return { total, gatheredTotal, linkedTotal, items };
}

export interface PairingReviewCandidate {
  readonly name: string;
  readonly url: string;
  readonly rawScore: number;
  readonly codeHit: boolean;
}

// issue 387 E6 — top-8 kandidátov produktu pre rozhodovací panel ("✗ Zlé" →
// zoznam s "Vybrať"). LAZY (volá sa AŽ pri otvorení panelu, design komentár
// na tickete) — hlavný zoznam vyššie ukazuje len `chosenCandidate`, nikdy
// všetkých 8, aby sa nezaťažoval payload každej karty, čo sa nikdy
// nerozbalí. Dáta sú UŽ perzistované z E2-E4 (`pairing_candidate`), žiadny
// živý fetch (E5 to explicitne zamietla, kým to nebolo treba).
export async function listPairingCandidatesForProduct(db: Database, productKey: string): Promise<readonly PairingReviewCandidate[]> {
  const rows = await db
    .select({
      name: pairingCandidates.name,
      url: pairingCandidates.url,
      rawScore: pairingCandidates.rawScore,
      codeHit: pairingCandidates.codeHit,
      position: pairingCandidates.position,
    })
    .from(pairingCandidates)
    .where(eq(pairingCandidates.productKey, productKey));

  return rows
    .sort((a, b) => a.position - b.position)
    .map((r) => ({ name: r.name, url: r.url, rawScore: Number(r.rawScore), codeHit: r.codeHit }));
}
