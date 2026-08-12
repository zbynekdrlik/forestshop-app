// Doslovný port `src/parovanie/ranking.py` zo starej appky (commit
// 60b6164, issue 387 E1): kód-zhoda VŽDY prebije menovú zhodu (+1000),
// inak rozhoduje `token_set_ratio` na vyčistenom mene. Prahy istoty
// ≥1000 high / ≥80 medium / inak low — vždy sa vráti najlepší kandidát,
// aj slabý (`pick_best`'s posledný riadok v starej appke, „auto-fill").

import { cleanName, codePresent } from "./normalize.js";
import { tokenSetRatio } from "./token-set-ratio.js";
import type { PairingCandidate, PairingConfidence, PairingProduct } from "./types.js";

// Adaptácia (E1, rovnaká ako `queries.ts`): produkt môže niesť VIACERO
// externých kódov (jeden per variant) namiesto starej appka's jedného —
// zhoda platí, keď sa hociktorý z nich vyskytne v kandidátovej "hay"
// (meno + URL + kód).
function isCodeHit(product: PairingProduct, candidate: PairingCandidate): boolean {
  if (product.externalCodes.length === 0) return false;
  const hay = [candidate.name, candidate.url, candidate.code ?? ""].filter(Boolean).join(" ");
  return product.externalCodes.some((code) => codePresent(code, hay));
}

function nameScore(product: PairingProduct, candidate: PairingCandidate): number {
  return tokenSetRatio(cleanName(product.name), candidate.name);
}

/**
 * Zoradí kandidátov podľa `rawScore` zostupne — port `ranking.py`'s
 * `rank()`. Na rozdiel od starej appky (mutuje `Candidate.raw_score` na
 * mieste) vracia NOVÉ objekty — vstupné pole ostáva nedotknuté.
 */
export function rank(product: PairingProduct, candidates: readonly PairingCandidate[]): PairingCandidate[] {
  const scored = candidates.map((candidate): PairingCandidate => {
    const codeHit = isCodeHit(product, candidate);
    const rawScore = codeHit ? 1000 + nameScore(product, candidate) : nameScore(product, candidate);
    return { ...candidate, rawScore, codeHit };
  });
  return scored.sort((a, b) => b.rawScore - a.rawScore);
}

export interface PairingPick {
  readonly candidate: PairingCandidate | null;
  readonly confidence: PairingConfidence;
}

/**
 * Vyberie najlepšieho kandidáta a jeho istotu — port `ranking.py`'s
 * `pick_best()`. Prázdny zoznam kandidátov → `none`. Inak sa VŽDY vráti
 * najlepší nájdený kandidát (auto-fill), aj keď je jeho skóre nízke —
 * stará appka mala pre tento prípad samostatnú `>= 50.0` vetvu, ktorá
 * vracala rovnaké `"low"` ako vetva pod ňou; tu je preto zjednodušená na
 * jeden `else` bez straty správania (over: staré `>= 50.0` aj fallback
 * vetva vracajú identický reťazec).
 */
export function pickBest(product: PairingProduct, candidates: readonly PairingCandidate[]): PairingPick {
  if (candidates.length === 0) return { candidate: null, confidence: "none" };
  const [best] = rank(product, candidates);
  // `candidates.length > 0` guarantees `rank()` (a same-length `.map()`)
  // returns a non-empty array too — this check only satisfies
  // `noUncheckedIndexedAccess`'s static narrowing, never a real runtime path.
  if (!best) return { candidate: null, confidence: "none" };
  if (best.rawScore >= 1000) return { candidate: best, confidence: "high" };
  if (best.rawScore >= 80) return { candidate: best, confidence: "medium" };
  return { candidate: best, confidence: "low" };
}
