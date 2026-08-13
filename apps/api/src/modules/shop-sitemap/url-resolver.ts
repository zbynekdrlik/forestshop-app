// issue 402: port starej appky's `parovanie.url_resolver` (https://github.com/
// zbynekdrlik/parovanie_produktov @ HEAD, `src/parovanie/url_resolver.py`) —
// `resolve()`/`dedup()`/`assignUrls()` sú doslovný port. `disambiguate()`
// je UPRAVENÁ: stará appka disambiguuje viacnásobných kandidátov cez
// PRODUKTOVÉ OBRÁZKY (`our_images`, zo Shoptet CSV `defaultImage`/`image2..`),
// ale KATALÓGOVÝ IMPORT tejto appky (`catalog/map-row.ts`) obrázky vôbec
// neukladá (súbežný worker issue 397 rieši presne túto "bez obrázka" medzeru
// na tej istej karte — pridávanie zachytávania obrázkov sem by kolidovalo).
// Náhrada (design komentár na tickete, issue 402): keď je viac kandidátov
// (zhoda na token-superset mena), vyhrá ten s NAJMENEJ nevysvetlenými
// tokenmi navyše OPROTI SAMOTNÉMU MENU produktu (rovnaký princíp ako stará
// appky `disambiguate()`'s druhá polovica — "fewest unexplained extra
// tokens" tiebreak — len bez obrázkového "explained" seedu). Bez
// JEDNOZNAČNÉHO víťaza sa nehádä (`null`) — "zlý odkaz je horší než žiadny"
// zásada platí rovnako.

import { slug, tokens } from "./slug.js";

export const BASE_URL = "https://www.forestshop.sk/";

// Sila rozlíšenia (vyššia = dôveryhodnejšia), používaná `dedup()`om.
export const STRENGTH_EXACT = 3; // meno produktu JE sitemap slug
export const STRENGTH_SINGLE = 2; // presne jeden token-superset kandidát
export const STRENGTH_TIEBREAK = 1; // disambiguované cez "fewest extra tokens"
export const STRENGTH_NONE = 0;
// Sentinel pre URL, čo INÝ produkt už nesie (naprieč behmi, nikdy z TOHTO
// resolve()u) — vyššia než čokoľvek, čo `resolve()` môže vrátiť, takže
// existujúci odkaz sa v `dedup()`e NIKDY nedisplacne.
export const STRENGTH_EXISTING = 99;

export interface ResolveResult {
  readonly url: string | null;
  readonly strength: number;
  readonly nameSlug: string;
}

export interface SlugIndex {
  readonly slugset: ReadonlySet<string>;
  readonly slugTokens: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Pre-tokenize the sitemap slug list once. */
export function buildIndex(slugs: readonly string[]): SlugIndex {
  const slugset = new Set(slugs);
  const slugTokens = new Map<string, ReadonlySet<string>>();
  for (const s of slugs) slugTokens.set(s, tokens(s));
  return { slugset, slugTokens };
}

function isSubsetOf(subset: ReadonlySet<string>, superset: ReadonlySet<string>): boolean {
  for (const t of subset) {
    if (!superset.has(t)) return false;
  }
  return true;
}

/**
 * Viac kandidátov zhodných na token-superset mena — vyhrá ten s NAJMENEJ
 * tokenmi navyše oproti `nameSlug`u (jednoznačný víťaz vyžadovaný, inak
 * `null`). Pozri súborovú hlavičku pre zdôvodnenie odchýlky od starej
 * appky's obrázkovej disambiguácie.
 */
export function disambiguateByTokens(candidateSlugs: readonly string[], nameSlug: string, slugTokens: ReadonlyMap<string, ReadonlySet<string>>): string | null {
  if (candidateSlugs.length === 0) return null;
  if (candidateSlugs.length === 1) {
    const [only] = candidateSlugs;
    return only ?? null;
  }

  const nt = tokens(nameSlug);
  const extraCount = (s: string): number => {
    const st = slugTokens.get(s) ?? new Set<string>();
    let n = 0;
    for (const t of st) {
      if (!nt.has(t)) n += 1;
    }
    return n;
  };

  const ranked = [...candidateSlugs].sort((a, b) => extraCount(a) - extraCount(b) || a.localeCompare(b));
  const best = ranked[0];
  const second = ranked[1];
  if (best === undefined) return null; // nedosiahnuteľné (length >= 2 overené vyššie)
  if (second === undefined) return best; // nedosiahnuteľné (length >= 2 overené vyššie)
  return extraCount(best) < extraCount(second) ? best : null;
}

/** Best forestshop URL for ONE product. */
export function resolve(name: string, index: SlugIndex): ResolveResult {
  const sn = slug(name);
  if (sn === "") return { url: null, strength: STRENGTH_NONE, nameSlug: sn };
  if (index.slugset.has(sn)) return { url: BASE_URL + sn + "/", strength: STRENGTH_EXACT, nameSlug: sn };

  const nt = tokens(sn);
  if (nt.size === 0) return { url: null, strength: STRENGTH_NONE, nameSlug: sn };

  const candidates: string[] = [];
  for (const [s, st] of index.slugTokens) {
    if (isSubsetOf(nt, st)) candidates.push(s);
  }
  if (candidates.length === 0) return { url: null, strength: STRENGTH_NONE, nameSlug: sn };
  if (candidates.length === 1) {
    const [only] = candidates;
    return { url: BASE_URL + (only ?? "") + "/", strength: STRENGTH_SINGLE, nameSlug: sn };
  }

  const winner = disambiguateByTokens(candidates, sn, index.slugTokens);
  if (winner === null) return { url: null, strength: STRENGTH_NONE, nameSlug: sn };
  return { url: BASE_URL + winner + "/", strength: STRENGTH_TIEBREAK, nameSlug: sn };
}

/**
 * Enforce that two DIFFERENT products never share a resolved URL: keep the
 * strongest match, `null` the rest; a tie among different products drops
 * all (a wrong link is worse than no link). Two entries with the SAME
 * `nameSlug` are a genuine catalog duplicate and both legitimately keep
 * the URL. Mutates nothing; returns `{index: url_or_null}`.
 */
export function dedup(resolved: readonly ResolveResult[]): ReadonlyMap<number, string | null> {
  const at = (i: number): ResolveResult => {
    const v = resolved[i];
    if (v === undefined) throw new Error("dedup: index mimo rozsahu — nedosiahnuteľné, indexy pochádzajú z toho istého poľa");
    return v;
  };

  const out = new Map<number, string | null>();
  resolved.forEach((r, i) => out.set(i, r.url));

  const byUrl = new Map<string, number[]>();
  resolved.forEach((r, i) => {
    if (r.url === null) return;
    const idxs = byUrl.get(r.url);
    if (idxs === undefined) byUrl.set(r.url, [i]);
    else idxs.push(i);
  });

  for (const idxs of byUrl.values()) {
    if (idxs.length < 2) continue;
    const nameSlugs = new Set(idxs.map((i) => at(i).nameSlug));
    if (nameSlugs.size === 1) continue; // genuine duplicate product — both keep the one page

    const best = Math.max(...idxs.map((i) => at(i).strength));
    const winners = idxs.filter((i) => at(i).strength === best);
    if (winners.length > 1 && new Set(winners.map((i) => at(i).nameSlug)).size > 1) {
      for (const i of idxs) out.set(i, null); // tie among different products — cannot tell, drop all
      continue;
    }
    const keep = new Set(winners);
    for (const i of idxs) {
      if (!keep.has(i)) out.set(i, null);
    }
  }
  return out;
}

/**
 * Resolve every product against the sitemap, then enforce that two
 * DIFFERENT products never share a URL. Returns `{index_in_products:
 * url_or_null}`; mutates nothing.
 */
export function assignUrls(names: readonly string[], slugs: readonly string[]): ReadonlyMap<number, string | null> {
  const index = buildIndex(slugs);
  const resolved = names.map((name) => resolve(name, index));
  return dedup(resolved);
}
