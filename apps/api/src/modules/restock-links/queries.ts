import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { productSupplierLinkOverrides, products, variants } from "../../db/schema.js";
import { resolveEffectiveSupplierLink } from "../orders/effective-supplier-link.js";
import { SELLABLE_VISIBILITY } from "../restock/constants.js";

// issue 311: diagnostika #307 zistila, že 91 zo 130 vypredaných produktov
// (rovnaká populácia ako `restock/queries.ts`'s `allRestockCandidates` —
// `out_of_stock` + `product_visibility = 'visible'` + `missing_since IS
// NULL`, BEZ podmienok o potvrdení dodávateľa, tie sem nepatria) nemá VÔBEC
// žiadnu dodávateľskú linku v poznámke — automatika ich preto nikdy
// neposúdi. Táto obrazovka NAVRHNE kandidáta (deterministické zhodovanie
// VÝZNAMNÝCH SLOV názvu, rovnaký princíp ako `search/queries.ts`'s
// `globalSearch`, len nad VLASTNÝM katalógom — nikdy AI dohad, `.claude/
// rules/supplier-stock.md`), ČLOVEK potvrdí/upraví a zápis ide cez UŽ
// EXISTUJÚCU `POST /api/product-links/:productKey` (#239,
// `setProductSupplierLinkForProduct`) — žiadna nová zapisovacia cesta,
// žiadna nová tabuľka. Kandidáti sa počítajú ŽIVO pri každom načítaní,
// nikdy sa neperzistujú (rovnaký princíp ako `feed-cross-check.ts`).
export interface RestockLinkCandidate {
  readonly productKey: string;
  readonly productName: string;
  readonly supplier: string | null;
  readonly url: string;
}

export interface RestockLinkMissingItem {
  readonly productKey: string;
  readonly productName: string;
  readonly supplier: string | null;
  readonly candidates: readonly RestockLinkCandidate[];
}

export interface RestockLinksSearchInput {
  readonly q: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface RestockLinksSearchResult {
  readonly total: number;
  readonly items: readonly RestockLinkMissingItem[];
}

const CANDIDATE_LIMIT = 3;
// Bonus pridaný ku skóre zhody mien, keď oba produkty majú ROVNAKÉHO
// dodávateľa (`product.supplier`, case/orez-insensitive) — vždy vyhrá nad
// akoukoľvek čisto textovou zhodou naprieč cudzími dodávateľmi.
const SAME_SUPPLIER_BONUS = 100;

// Slovenská diakritika → ASCII, aby sa tokeny porovnávali nezávisle od
// pravopisu ("Nôž" ~ "noz").
const SK_DIACRITICS: Readonly<Record<string, string>> = {
  á: "a",
  ä: "a",
  č: "c",
  ď: "d",
  é: "e",
  í: "i",
  ľ: "l",
  ĺ: "l",
  ň: "n",
  ó: "o",
  ô: "o",
  ŕ: "r",
  š: "s",
  ť: "t",
  ú: "u",
  ý: "y",
  ž: "z",
};

function normalizeChar(ch: string): string {
  return SK_DIACRITICS[ch] ?? ch;
}

// Významné slová názvu — 3+ znaky (krátke spojky "na"/"v"/"a" sa nikdy
// nezhodujú náhodou, veľkosti ako "XL" majú presne 2 znaky a sú tu zámerne
// vylúčené — zhoda podľa veľkosti by bola falošný signál medzi úplne
// rôznymi produktmi rovnakej veľkostnej rady). Čisto deterministické, žiadny
// slovník, žiadna AI.
function significantTokens(name: string): ReadonlySet<string> {
  const normalized = name
    .toLowerCase()
    .split("")
    .map(normalizeChar)
    .join("");
  const tokens = normalized.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  return new Set(tokens);
}

interface LinkedProduct {
  readonly productKey: string;
  readonly productName: string;
  readonly supplier: string | null;
  readonly url: string;
  readonly tokens: ReadonlySet<string>;
}

function normalizeSupplierKey(supplier: string | null): string | null {
  const trimmed = supplier?.trim().toLowerCase() ?? "";
  return trimmed === "" ? null : trimmed;
}

function overlapScore(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let score = 0;
  for (const token of a) {
    if (b.has(token)) score += 1;
  }
  return score;
}

function suggestCandidates(
  target: { readonly productName: string; readonly supplier: string | null },
  linked: readonly LinkedProduct[],
): readonly RestockLinkCandidate[] {
  const targetTokens = significantTokens(target.productName);
  const targetSupplier = normalizeSupplierKey(target.supplier);

  const scored: { readonly candidate: LinkedProduct; readonly score: number }[] = [];
  for (const candidate of linked) {
    const nameScore = overlapScore(targetTokens, candidate.tokens);
    if (nameScore === 0) continue;
    const sameSupplier = targetSupplier !== null && normalizeSupplierKey(candidate.supplier) === targetSupplier;
    scored.push({ candidate, score: nameScore + (sameSupplier ? SAME_SUPPLIER_BONUS : 0) });
  }
  scored.sort((a, b) => b.score - a.score || a.candidate.productName.localeCompare(b.candidate.productName, "sk"));

  return scored.slice(0, CANDIDATE_LIMIT).map(({ candidate }) => ({
    productKey: candidate.productKey,
    productName: candidate.productName,
    supplier: candidate.supplier,
    url: candidate.url,
  }));
}

export async function listRestockLinkSuggestions(
  db: Database,
  input: RestockLinksSearchInput,
): Promise<RestockLinksSearchResult> {
  const productRows = await db
    .select({
      productKey: products.key,
      productName: products.name,
      supplier: products.supplier,
      internalNote: products.internalNote,
      overrideUrl: productSupplierLinkOverrides.url,
    })
    .from(products)
    .leftJoin(productSupplierLinkOverrides, eq(productSupplierLinkOverrides.productKey, products.key));

  const soldOutRows = await db
    .selectDistinct({ productKey: variants.productKey })
    .from(variants)
    .where(
      and(
        eq(variants.state, "out_of_stock"),
        eq(variants.productVisibility, SELLABLE_VISIBILITY),
        isNull(variants.missingSince),
      ),
    );
  const soldOutKeys = new Set(soldOutRows.map((row) => row.productKey));

  const linked: LinkedProduct[] = [];
  const missing: { productKey: string; productName: string; supplier: string | null }[] = [];
  for (const row of productRows) {
    const effective = resolveEffectiveSupplierLink(row.internalNote, row.overrideUrl);
    if (effective.url !== null) {
      linked.push({
        productKey: row.productKey,
        productName: row.productName,
        supplier: row.supplier,
        url: effective.url,
        tokens: significantTokens(row.productName),
      });
    } else if (soldOutKeys.has(row.productKey)) {
      missing.push({ productKey: row.productKey, productName: row.productName, supplier: row.supplier });
    }
  }

  const q = input.q.trim().toLowerCase();
  const filtered = missing.filter(
    (item) => q === "" || item.productKey.toLowerCase().includes(q) || item.productName.toLowerCase().includes(q),
  );
  filtered.sort((a, b) => a.productName.localeCompare(b.productName, "sk"));

  const total = filtered.length;
  const start = (input.page - 1) * input.pageSize;
  const page = filtered.slice(start, start + input.pageSize);

  const items: RestockLinkMissingItem[] = page.map((item) => ({
    ...item,
    candidates: suggestCandidates(item, linked),
  }));

  return { total, items };
}
