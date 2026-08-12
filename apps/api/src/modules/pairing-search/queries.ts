// Doslovný port `src/parovanie/matcher.py`'s `query_ladder`/`query_variants`
// zo starej appky (commit 60b6164, issue 387 E1), ADAPTOVANÝ na viacero
// `external_code` hodnôt na produkt namiesto jednej — pozri `types.ts`'s
// hlavičkový komentár a návrh (issue 387 komentár, sekcia „Čo sa adaptuje").

import { cleanName } from "./normalize.js";
import type { PairingProduct } from "./types.js";

// Generické slovenské kategóriové/prídavné slová, ktoré produkt
// nerozlišujú — DOSLOVNÝ port `matcher.py`'s `GENERIC` množiny (46 slov,
// obe diakritické aj bezdiakritické tvary zachované presne).
export const GENERIC_WORDS: ReadonlySet<string> = new Set([
  "nohavice",
  "bunda",
  "mikina",
  "vesta",
  "košeľa",
  "kosela",
  "tričko",
  "tricko",
  "komplet",
  "set",
  "súprava",
  "suprava",
  "ponožky",
  "ponozky",
  "čiapka",
  "ciapka",
  "rukavice",
  "kraťasy",
  "kratasy",
  "šortky",
  "sortky",
  "obuv",
  "topánky",
  "topanky",
  "čižmy",
  "cizmy",
  "opasok",
  "taška",
  "taska",
  "batoh",
  "dámske",
  "damske",
  "pánske",
  "panske",
  "detské",
  "detske",
  "letné",
  "letne",
  "zimné",
  "zimne",
  "poľovnícke",
  "polovnicke",
  "strelecké",
  "strelecke",
  "membrána",
  "membrana",
]);

function dedupPreserveOrder(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (item && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

// Python's `token.lower().strip("-,.")` — orež tieto znaky z OBOCH koncov,
// nikdy z vnútra tokenu.
function stripPunctLower(token: string): string {
  return token
    .toLowerCase()
    .replace(/^[-,.]+/, "")
    .replace(/[-,.]+$/, "");
}

/**
 * Zoradené dopyty na postupné skúšanie, kým jeden nevráti kandidátov —
 * port `matcher.py`'s `query_ladder`. Dlhé presné dopyty na dodávateľských
 * vyhľadávačoch často miss-nú, preto rebrík postupne skracuje meno.
 *
 * Adaptácia (E1): stará appka niesla presne JEDEN `external_code` na
 * zoskupený produkt (prvý neprázdny variantný kód videný pri CSV
 * groupingu). Tu je `external_code` per-VARIANT stĺpec, takže rebrík
 * skúša VŠETKY odlišné kódy produktu (každý na vlastnom stupienku) pred
 * tým, než padne na meno-založené stupienky.
 */
export function buildQueryLadder(product: PairingProduct): string[] {
  const queries: string[] = [...product.externalCodes];
  const name = cleanName(product.name);
  if (name) {
    queries.push(name);
    const tokens = name.split(" ");
    if (tokens.length > 3) queries.push(tokens.slice(0, 3).join(" "));
    if (tokens.length > 2) queries.push(tokens.slice(0, 2).join(" "));
  }
  return dedupPreserveOrder(queries);
}

/**
 * Niekoľko foriem dopytu na maximalizáciu recall-u — port `matcher.py`'s
 * `query_variants`: externý kód, celé meno, meno s odstránenými vedúcimi
 * generickými slovami, a prefix aj suffix skupiny tokenov (3 a 2) z
 * celého aj orezaného mena. Neskorší AI verifikátor (mimo rozsahu E1)
 * dedupuje a vyberá z tejto únie.
 *
 * Rovnaká viac-kódová adaptácia ako `buildQueryLadder`.
 */
export function buildQueryVariants(product: PairingProduct): string[] {
  const queries: string[] = [...product.externalCodes];
  const name = cleanName(product.name);
  if (name) {
    queries.push(name);
    const tokens = name.split(" ");
    let i = 0;
    while (i < tokens.length - 1 && GENERIC_WORDS.has(stripPunctLower(tokens[i] ?? ""))) {
      i += 1;
    }
    const stripped = i > 0 ? tokens.slice(i) : tokens;
    if (i > 0) queries.push(stripped.join(" "));
    for (const base of [tokens, stripped]) {
      for (const n of [3, 2]) {
        if (base.length > n) {
          queries.push(base.slice(0, n).join(" ")); // prefix
          queries.push(base.slice(-n).join(" ")); // suffix
        }
      }
    }
  }
  return dedupPreserveOrder(queries);
}
