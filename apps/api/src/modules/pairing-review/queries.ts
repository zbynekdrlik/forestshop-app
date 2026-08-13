// issue 387 E5: "Eshop → Párovanie" — čítacia obrazovka nad tým, čo E3
// (gather) + E4 (verify) už zozbierali a overili.
//
// issue 387 E6: `pairing_decision` (E5's forward-kompat poznámka) teraz
// EXISTUJE — "unreviewed" ostáva PRIMÁRNE "bez efektívnej linky" (E5's
// doslovná zhoda so zadaním), ĎALEJ ZÚŽENÉ o produkty, čo už dostali
// TERMINÁLNE rozhodnutie (`unavailable`/`discontinued` — tie linku NIKDY
// nedostanú, ale SÚ zrevidované, netreba na ne ďalej upozorňovať). Design
// komentár na tickete (issue 387 E6): API kontrakt sa nemení, len sa
// definícia SPRESŇUJE.
//
// issue 401: populácia UŽ NIE JE len "produkty S KANDIDÁTMI" (E5's pôvodná
// INNER JOIN hranica) — majiteľ chcel VŠETKY produkty bez napárovaného
// odkazu, bez ohľadu na dodávateľa. `listPairingReview` preto teraz iteruje
// ÚNIU troch množín (má `pairing_candidate_set` riadok, ALEBO nemá efektívnu
// linku, ALEBO má `pairing_decision` riadok) — pozri design komentár na
// #398/#401 pre plné odôvodnenie. Rovnaký MVP vzor ako
// `product-links/queries.ts`/`restock-links/queries.ts`/`pairing-search/
// select.ts` — celý katalóg sa načíta a filtruje/triedi/stránkuje v JS,
// keďže `resolveEffectiveSupplierLink` je čistá JS funkcia nad
// `internalNote`, nedá sa vyjadriť ako SQL predikát bez duplicity.

import { eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  pairingCandidates,
  pairingCandidateSets,
  pairingDecisions,
  productSupplierLinkOverrides,
  products,
  shopProductUrl,
  suppliers,
  variants,
} from "../../db/schema.js";
import { resolveEffectiveSupplierLink } from "../orders/effective-supplier-link.js";
import { normalizeSupplierKeyJs } from "../orders/supplier-key.js";
import type { PairingConfidence, PairingVerdict } from "../pairing-search/types.js";
import { SELLABLE_VISIBILITY } from "../restock/constants.js";
import type { PairingDecisionStatus } from "./decisions.js";

export type PairingReviewFilter = "unreviewed" | "matched" | "unmatched" | "st1" | "st2" | "st3" | "decided" | "terminal" | "all";
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
  /** issue 401 — `true` = `product.supplier` sa normalizuje na `suppliers`
   * riadok s vyplneným `adapter_key` (WETLAND/BETALOV/ODIMON). Karta podľa
   * toho rozlišuje "dodávateľ zatiaľ nemá automatické vyhľadávanie" (false)
   * od "gather zatiaľ nič nenašiel/nebehol" (true, ale `gatheredAt === null`
   * alebo `chosenCandidate === null`). */
  readonly supplierHasAdapter: boolean;
  /** issue 401 — `null` keď pre produkt ešte NEEXISTUJE `pairing_candidate_set`
   * riadok (nikdy nebol gatherovaný — typicky dodávateľ bez adaptéra, alebo
   * adaptérový produkt, čo ešte nočný beh nestihol spracovať). */
  readonly gatheredAt: string | null;
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
  /** issue 401 — CELÁ populácia tejto obrazovky (únia: gatherované produkty +
   * produkty bez efektívnej linky + rozhodnuté produkty, viď `listPairingReview`),
   * nezávisle od `filter` — menovateľ pre progress. Meno poľa ostalo z E5
   * (kedy populácia = "len gatherované"), význam sa odvtedy rozšíril. */
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

// issue 401 — dodávateľ SO ZNÁMYM adaptérom (WETLAND/BETALOV/ODIMON), presne
// rovnaký zdroj/normalizácia ako `pairing-search/select.ts`'s
// `selectEligibleProducts` (zámerne duplikované — malá, 5-riadková mapa,
// zdieľanie by tu pridalo len ďalší modul navyše bez skutočného úžitku).
async function loadAdapterByNormalizedSupplier(db: Database): Promise<ReadonlyMap<string, string>> {
  const supplierRows = await db.select({ name: suppliers.name, adapterKey: suppliers.adapterKey }).from(suppliers);
  const map = new Map<string, string>();
  for (const row of supplierRows) {
    if (row.adapterKey !== null) map.set(normalizeSupplierKeyJs(row.name), row.adapterKey);
  }
  return map;
}

export async function listPairingReview(db: Database, input: PairingReviewSearchInput): Promise<PairingReviewSearchResult> {
  // issue 401 — populácia je ÚNIA troch množín (design komentár na tickete
  // 398/401): (1) produkty S `pairing_candidate_set` riadkom (gatherované,
  // akéhokoľvek dodávateľa), (2) produkty BEZ efektívnej dodávateľskej linky
  // (akéhokoľvek dodávateľa — adaptér alebo nie), (3) produkty S
  // `pairing_decision` riadkom (rozhodnuté cez TÚTO obrazovku — zostávajú
  // viditeľné aj keď medzitým získajú efektívnu linku, napr. "manual").
  // Rovnaký MVP vzor ako `pairing-search/select.ts`/`product-links`/
  // `restock-links` — celý katalóg do JS, filtrovanie/spájanie tam
  // (`resolveEffectiveSupplierLink` je čistá JS funkcia, nedá sa vyjadriť
  // ako SQL predikát bez duplicity — súborová hlavička).
  const productRows = await db
    .select({ key: products.key, name: products.name, supplier: products.supplier, internalNote: products.internalNote })
    .from(products);
  if (productRows.length === 0) return { total: 0, gatheredTotal: 0, linkedTotal: 0, items: [] };

  const overrideRowsAll = await db
    .select({ productKey: productSupplierLinkOverrides.productKey, url: productSupplierLinkOverrides.url })
    .from(productSupplierLinkOverrides);
  const overrideByProduct = new Map(overrideRowsAll.map((r) => [r.productKey, r.url]));

  const setRowsAll = await db
    .select({
      productKey: pairingCandidateSets.productKey,
      gatheredAt: pairingCandidateSets.gatheredAt,
      chosenUrl: pairingCandidateSets.chosenUrl,
      chosenReason: pairingCandidateSets.chosenReason,
      confidence: pairingCandidateSets.confidence,
      verdict: pairingCandidateSets.verdict,
    })
    .from(pairingCandidateSets);
  const setByProduct = new Map(setRowsAll.map((r) => [r.productKey, r]));

  const decisionRowsAll = await db
    .select({
      productKey: pairingDecisions.productKey,
      status: pairingDecisions.status,
      url: pairingDecisions.url,
      decidedAt: pairingDecisions.decidedAt,
    })
    .from(pairingDecisions);
  const decisionByProduct = new Map(decisionRowsAll.map((r) => [r.productKey, r]));

  const adapterByNormalizedSupplier = await loadAdapterByNormalizedSupplier(db);

  const productKeys: string[] = [];
  for (const product of productRows) {
    const effective = resolveEffectiveSupplierLink(product.internalNote, overrideByProduct.get(product.key) ?? null);
    const hasCandidateSet = setByProduct.has(product.key);
    const hasDecision = decisionByProduct.has(product.key);
    if (hasCandidateSet || effective.url === null || hasDecision) productKeys.push(product.key);
  }
  if (productKeys.length === 0) return { total: 0, gatheredTotal: 0, linkedTotal: 0, items: [] };

  const productByKey = new Map(productRows.map((r) => [r.key, r]));

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

  const allItems: PairingReviewItem[] = [];
  for (const productKey of productKeys) {
    const product = productByKey.get(productKey);
    // Nedosiahnuteľné (`productKey` vzišlo priamo z `productRows` vyššie) —
    // len na uspokojenie `noUncheckedIndexedAccess`/typovej kontroly.
    if (product === undefined) continue;

    const set = setByProduct.get(productKey);
    const productVariants = variantsByProduct.get(productKey) ?? [];

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

    const effective = resolveEffectiveSupplierLink(product.internalNote, overrideByProduct.get(productKey) ?? null);

    const chosenUrl = set?.chosenUrl ?? null;
    const chosenCandidateRow = chosenUrl === null ? undefined : candidateByKey.get(`${productKey} ${chosenUrl}`);
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

    const decisionRow = decisionByProduct.get(productKey);
    const decision: PairingReviewDecision | null =
      decisionRow === undefined ? null : { status: decisionRow.status, url: decisionRow.url, decidedAt: decisionRow.decidedAt.toISOString() };

    allItems.push({
      productKey,
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
      supplierHasAdapter: adapterByNormalizedSupplier.has(normalizeSupplierKeyJs(product.supplier ?? "")),
      gatheredAt: set !== undefined ? set.gatheredAt.toISOString() : null,
      confidence: set?.confidence ?? "none",
      chosenReason: set?.chosenReason ?? null,
      verdict: set?.verdict ?? null,
      chosenCandidate,
      decision,
    });
  }

  // issue 401 — mená polí (`gatheredTotal`/`linkedTotal`) ostávajú NEZMENENÉ
  // (API kontrakt), ale VÝZNAM sa rozšíril spolu s populáciou vyššie —
  // `gatheredTotal` je teraz "koľko produktov appka na tejto obrazovke
  // sleduje" (nie len "koľko bolo gatherovaných"), badge/progress bar
  // (`PairingReviewSection.tsx`) tak automaticky počítajú novú, plnú
  // populáciu bez zmeny na strane frontendu.
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
      case "decided":
        return item.decision !== null && (item.decision.status === "good" || item.decision.status === "manual");
      case "terminal":
        return item.decision !== null && (item.decision.status === "unavailable" || item.decision.status === "discontinued");
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
  /** issue 409 — obrázok kandidáta (z adaptéra pri gatheri, presne ako
   * `PairingReviewChosenCandidate.imageUrl` vyššie), `null` keď žiadny zdroj
   * neposkytol použiteľný. Dáta sú UŽ perzistované (žiadny live-fetch pri
   * otvorení panelu) — pozri design komentár na #398/#409. */
  readonly imageUrl: string | null;
  readonly rawScore: number;
  readonly codeHit: boolean;
}

// issue 387 E6 — top-8 kandidátov produktu pre rozhodovací panel ("vyber
// url" → zoznam s "Vybrať"). LAZY (volá sa AŽ pri otvorení panelu, design
// komentár na tickete) — hlavný zoznam vyššie ukazuje len `chosenCandidate`,
// nikdy všetkých 8, aby sa nezaťažoval payload každej karty, čo sa nikdy
// nerozbalí. Dáta sú UŽ perzistované z E2-E4 (`pairing_candidate`), žiadny
// živý fetch (E5 to explicitne zamietla, kým to nebolo treba).
export async function listPairingCandidatesForProduct(db: Database, productKey: string): Promise<readonly PairingReviewCandidate[]> {
  const rows = await db
    .select({
      name: pairingCandidates.name,
      url: pairingCandidates.url,
      imageUrl: pairingCandidates.imageUrl,
      rawScore: pairingCandidates.rawScore,
      codeHit: pairingCandidates.codeHit,
      position: pairingCandidates.position,
    })
    .from(pairingCandidates)
    .where(eq(pairingCandidates.productKey, productKey));

  return rows
    .sort((a, b) => a.position - b.position)
    .map((r) => ({ name: r.name, url: r.url, imageUrl: r.imageUrl, rawScore: Number(r.rawScore), codeHit: r.codeHit }));
}
