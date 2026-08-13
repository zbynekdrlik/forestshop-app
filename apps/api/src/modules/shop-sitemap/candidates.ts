// issue 402: port starej appky's `scripts/resolve_urls.py` — kandidátne slugy
// pre produkty MIMO sitemapy (`candidates()`, doslovný port) + probe
// rozlíšenie (`resolve_probe()`, UPRAVENÉ — bez obrázkovej disambiguácie,
// pozri `url-resolver.ts`'s súborová hlavička pre zdôvodnenie).

import { slug, tokens } from "./slug.js";
import { disambiguateByTokens, STRENGTH_NONE, STRENGTH_SINGLE, STRENGTH_TIEBREAK, type ResolveResult } from "./url-resolver.js";

// Doslovný port starej appky's `GEN` — generické tovarové slová, ktoré sa
// odrežú z ČELA kandidáta, keď produkt nie je v sitemape pod plným menom
// (napr. "Poľovnícke nohavice Forest" → skús aj "forest" samotné).
const GEN: ReadonlySet<string> = new Set([
  "nohavice", "bunda", "mikina", "vesta", "komplet", "set", "ponozky", "ciapka",
  "rukavice", "kratasy", "sortky", "obuv", "damske", "panske", "detske", "letne",
  "zimne", "polovnicke", "strelecke", "ochranne", "lovecke", "klobuk", "siltovka",
  "vreckovy", "flisova", "funkcne", "zatvaraci", "suprava",
]);

/**
 * Kandidátne slugy pre produkt, čo nie je v sitemape. Doslovný port
 * `resolve_urls.candidates(name)`: základný slug (s odrezaným vedúcim
 * číselným indexom), variant s odrezanými ÚVODNÝMI generickými slovami, a
 * tri "polovnícke"/"polovnícka"/"polovnícky" prefixové varianty — deduped,
 * v poradí prvého výskytu.
 */
export function candidateSlugs(name: string): readonly string[] {
  const base = slug(name, true);
  const out: string[] = [base];

  const toks = base.split("-");
  let i = 0;
  while (i < toks.length - 1 && GEN.has(toks[i] ?? "")) i += 1;
  if (i > 0) out.push(toks.slice(i).join("-"));

  for (const p of ["polovnicke-", "polovnicka-", "polovnicky-"]) out.push(p + base);

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const c of out) {
    if (c !== "" && !seen.has(c)) {
      seen.add(c);
      deduped.push(c);
    }
  }
  return deduped;
}

/** `candidateSlugs(name)`'s kandidát → potvrdená URL (`null` = 404/nesedí), volané KAŽDÝM kandidátom (throttle je vnútri, `probe-fetcher.ts`). */
export type ProbeFetch = (candidateSlug: string) => Promise<string | null>;

/**
 * Rozlíši JEDNO produkt mimo sitemapy sondovaním VŠETKÝCH `candidateSlugs`
 * (nikdy sa nezastaví na prvom 200) — keď je potvrdených viac než jeden,
 * disambiguuje rovnakou "fewest extra tokens" logikou ako `url-resolver.ts`'s
 * `resolve()`. Nikdy nehádaj pri remíze — `null`.
 */
export async function resolveProbe(name: string, fetchCandidate: ProbeFetch): Promise<ResolveResult> {
  const nameSlug = slug(name);
  const hits: [string, string][] = [];
  for (const candidate of candidateSlugs(name)) {
    const url = await fetchCandidate(candidate);
    if (url !== null) hits.push([candidate, url]);
  }

  if (hits.length === 0) return { url: null, strength: STRENGTH_NONE, nameSlug };
  if (hits.length === 1) {
    const [only] = hits;
    return { url: only === undefined ? null : only[1], strength: STRENGTH_SINGLE, nameSlug };
  }

  const hitSlugs = hits.map(([c]) => c);
  const slugTokens = new Map(hitSlugs.map((c) => [c, tokens(c)]));
  const winner = disambiguateByTokens(hitSlugs, nameSlug, slugTokens);
  if (winner === null) return { url: null, strength: STRENGTH_NONE, nameSlug };

  const winningUrl = new Map(hits).get(winner);
  return { url: winningUrl ?? null, strength: STRENGTH_TIEBREAK, nameSlug };
}
