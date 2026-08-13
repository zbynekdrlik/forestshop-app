// Beh gather automatizácie (issue 387 E3+E4) — pre KAŽDÝ eligible produkt
// (`select.ts`) skúsi VŠETKY `buildQueryVariants` (union, port starej
// appky's `matcher.py`'s `gather_candidates(product, client, k=8)` — NIE
// `match_one`/`query_ladder`, viď design komentár na tickete), poolu je
// kandidátov podľa URL naprieč všetkými dopytmi, rankuje CELÝ pool a
// zapíše top-8 + `pickBest()`'s voľbu.
//
// **E4:** po `pickBest()`, keď je vybraný kandidát s `confidence`
// `high`/`medium`, overí sa jeho kód na detailnej stránke
// (`verify.ts`'s `verifyCandidateCode`) a výsledok (`verdict`/
// `verdictCheckedAt`) sa zapíše do TOHO ISTÉHO checkpointu. `low`/`none`
// (alebo žiadny kandidát) sa NIKDY neoveruje — šetrí requesty (dispatch
// E4, bod 2) a nízkoistotný kandidát má beztak malú šancu na zhodu.
//
// Checkpoint = per-produkt TRANSAKČNÝ upsert (`upsertCandidateSet`) —
// žiadna samostatná cursor tabuľka. Pád uprostred behu necháva už
// committnuté produkty s AKTUÁLNYM `input_hash` (ďalší beh ich sám
// preskočí, `select.ts`), zatiaľ čo produkt, pri ktorom beh spadol, nemá
// zapísaný nový `input_hash` → zostáva eligible pre ďalší beh. Per-produkt
// VÝNIMKA (sieť/parsing) sa zaloguje a zapíše do `errors`, cyklus
// pokračuje ĎALŠÍM produktom — ten istý princíp ako `posta-uncollected/
// run.ts`. Overenie SAMO nikdy nevyhodí (`verifyCandidateCode` zachytáva
// vlastné sieťové chyby a vracia `unsure`), takže nemôže spôsobiť túto
// per-produkt výnimku.

import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairingCandidateSets, pairingCandidates } from "../../db/schema.js";
import { log } from "../../logger.js";
import { CANDIDATE_LIMIT, PAIRING_SEARCH_RUN_LOCK_KEY, RUN_TIME_BUDGET_MS } from "./constants.js";
import { SearchClient } from "./client.js";
import { buildQueryVariants } from "./queries.js";
import { pickBest, rank, type PairingPick } from "./ranking.js";
import { selectEligibleProducts, type EligibleProduct } from "./select.js";
import type { PairingCandidate, PairingConfidence, PairingProduct, PairingVerdict } from "./types.js";
import { verifyCandidateCode } from "./verify.js";

export interface PairingSearchRunError {
  readonly productKey: string;
  readonly message: string;
}

export interface PairingSearchRunResult {
  readonly checkedAt: string;
  /** Koľko produktov beh na ZAČIATKU vôbec našiel ako eligible (pred
   * uplatnením časového stropu). */
  readonly eligible: number;
  readonly processed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly errors: readonly PairingSearchRunError[];
  /** `true` = beh narazil na `RUN_TIME_BUDGET_MS` skôr, než stihol
   * spracovať všetkých eligible produktov — pokračuje nasledujúcu noc. */
  readonly stoppedEarly: boolean;
}

export interface RunPairingSearchOptions {
  readonly db: Database;
  readonly now: Date;
  /** Iba pre testy — nahradí skutočný sieťový `SearchClient`. */
  readonly searchClient?: SearchClient;
  /** Iba pre testy — skráti/predĺži časový rozpočet behu. */
  readonly timeBudgetMs?: number;
  /** Iba pre testy — deterministický zdroj "uplynutého času" namiesto
   * skutočného `Date.now()`. */
  readonly clock?: () => number;
}

// Ďalší voľný advisory zámok kľúč, session-scoped (rovnaký vzor ako
// `posta-uncollected/run.ts`'s `POSTA_UNCOLLECTED_RUN_LOCK_KEY`) — vlastné,
// vyhradené pripojenie z poolu, NIE transakcia okolo celého behu (desiatky
// sekvenčných sieťových volaní na dodávateľov by zbytočne zaťažovali
// connection pool, keby ich obopínala jedna otvorená DB transakcia).
export async function runPairingSearch(options: RunPairingSearchOptions): Promise<PairingSearchRunResult> {
  const { db } = options;
  const lockClient = await db.$client.connect();
  try {
    await lockClient.query("select pg_advisory_lock($1)", [PAIRING_SEARCH_RUN_LOCK_KEY]);
    return await runPairingSearchLocked(options);
  } finally {
    await lockClient.query("select pg_advisory_unlock($1)", [PAIRING_SEARCH_RUN_LOCK_KEY]);
    lockClient.release();
  }
}

async function runPairingSearchLocked(options: RunPairingSearchOptions): Promise<PairingSearchRunResult> {
  const { db, now } = options;
  const searchClient = options.searchClient ?? new SearchClient();
  const timeBudgetMs = options.timeBudgetMs ?? RUN_TIME_BUDGET_MS;
  const clock = options.clock ?? Date.now;

  const eligible = await selectEligibleProducts(db);
  const deadlineMs = clock() + timeBudgetMs;

  let processed = 0;
  let succeeded = 0;
  const errors: PairingSearchRunError[] = [];
  let stoppedEarly = false;

  for (const item of eligible) {
    if (clock() >= deadlineMs) {
      stoppedEarly = true;
      break;
    }
    processed += 1;
    try {
      const { queries, candidates } = await gatherCandidates(searchClient, item);
      const pick = pickBest(item.product, candidates);
      const { verdict, verdictCheckedAt } = await verifyPickIfWarranted(searchClient, item.product, pick, now);
      await upsertCandidateSet(db, {
        productKey: item.product.productKey,
        gatheredAt: now,
        queries,
        inputHash: item.inputHash,
        chosenUrl: pick.candidate?.url ?? null,
        chosenReason: buildChosenReason(pick),
        confidence: pick.confidence,
        verdict,
        verdictCheckedAt,
        candidates,
      });
      succeeded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(
        { productKey: item.product.productKey, rawErrorMessage: message },
        "pairing-search: gather zlyhal pre produkt, pokračujem ďalším",
      );
      errors.push({ productKey: item.product.productKey, message });
    }
  }

  return {
    checkedAt: now.toISOString(),
    eligible: eligible.length,
    processed,
    succeeded,
    failed: errors.length,
    errors,
    stoppedEarly,
  };
}

/** Port `matcher.py`'s `gather_candidates` — skúsi VŠETKY query varianty
 * (nikdy sa nezastaví na prvom, ktorý niečo vrátil), poolu je kandidátov
 * podľa URL (prvý výskyt vyhráva, rovnaký vzor ako Pythonov
 * `pool.setdefault`), rankuje CELÝ pool proti produktu, vráti top-K. */
async function gatherCandidates(
  client: SearchClient,
  item: EligibleProduct,
): Promise<{ readonly queries: readonly string[]; readonly candidates: readonly PairingCandidate[] }> {
  const queryVariants = buildQueryVariants(item.product);
  const pool = new Map<string, PairingCandidate>();
  for (const query of queryVariants) {
    const found = await client.search(item.adapterKey, query);
    for (const candidate of found) {
      if (!pool.has(candidate.url)) pool.set(candidate.url, candidate);
    }
  }
  const ranked = rank(item.product, [...pool.values()]);
  return { queries: queryVariants, candidates: ranked.slice(0, CANDIDATE_LIMIT) };
}

interface VerifyOutcomeFields {
  readonly verdict: PairingVerdict | null;
  readonly verdictCheckedAt: Date | null;
}

/**
 * E4: overí kódovú zhodu vybraného kandidáta, ale LEN keď `confidence` je
 * `high`/`medium` (dispatch: "Verify len pre chosen_url s confidence
 * high/medium — šetri requesty"). `low`/`none`/žiadny kandidát → `verdict`/
 * `verdictCheckedAt` ostávajú `null`, presne ako E3 pred touto zmenou.
 */
async function verifyPickIfWarranted(
  client: SearchClient,
  product: PairingProduct,
  pick: PairingPick,
  now: Date,
): Promise<VerifyOutcomeFields> {
  if (pick.candidate === null || (pick.confidence !== "high" && pick.confidence !== "medium")) {
    return { verdict: null, verdictCheckedAt: null };
  }
  const outcome = await verifyCandidateCode(client, pick.candidate.url, product);
  return { verdict: outcome.verdict, verdictCheckedAt: now };
}

/** Krátky ľudsky čitateľný dôvod voľby — nová appka's pole, stará appka ho
 * nemala (mala len číselnú `confidence`). Diagnostický text pre budúcu
 * obrazovku (E5/E6), žiadny funkčný dopad v E3. */
function buildChosenReason(pick: PairingPick): string | null {
  if (pick.candidate === null) return null;
  if (pick.candidate.codeHit) return "kód dodávateľa sa zhoduje";
  return `zhoda mena (${String(Math.round(pick.candidate.rawScore))} %)`;
}

interface UpsertCandidateSetInput {
  readonly productKey: string;
  readonly gatheredAt: Date;
  readonly queries: readonly string[];
  readonly inputHash: string;
  readonly chosenUrl: string | null;
  readonly chosenReason: string | null;
  readonly confidence: PairingConfidence;
  readonly verdict: PairingVerdict | null;
  readonly verdictCheckedAt: Date | null;
  readonly candidates: readonly PairingCandidate[];
}

/** Checkpoint — JEDNA transakcia na produkt: upsert `candidate_set` +
 * úplná náhrada jeho `pairing_candidate` riadkov (delete+insert, nikdy
 * inkrementálny diff — top-8 je vždy "posledný pohľad", nie história).
 * `verdict`/`verdict_checked_at` ostávajú `null`, keď `verifyPickIfWarranted`
 * overenie preskočilo (`confidence` nízka alebo bez kandidáta, issue 387 E4). */
async function upsertCandidateSet(db: Database, input: UpsertCandidateSetInput): Promise<void> {
  await db.transaction(async (tx) => {
    const setValues = {
      gatheredAt: input.gatheredAt,
      queries: [...input.queries],
      inputHash: input.inputHash,
      chosenUrl: input.chosenUrl,
      chosenReason: input.chosenReason,
      confidence: input.confidence,
      verdict: input.verdict,
      verdictCheckedAt: input.verdictCheckedAt,
    };
    await tx
      .insert(pairingCandidateSets)
      .values({ productKey: input.productKey, ...setValues })
      .onConflictDoUpdate({ target: pairingCandidateSets.productKey, set: setValues });

    await tx.delete(pairingCandidates).where(eq(pairingCandidates.productKey, input.productKey));
    if (input.candidates.length > 0) {
      await tx.insert(pairingCandidates).values(
        input.candidates.map((candidate, position) => ({
          productKey: input.productKey,
          position,
          name: candidate.name,
          url: candidate.url,
          code: candidate.code,
          price: candidate.price,
          rawScore: candidate.rawScore.toFixed(4),
          codeHit: candidate.codeHit,
        })),
      );
    }
  });
}
