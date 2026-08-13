// issue 397 — jednorazový/opakovateľný backfill obrázka CHOSEN kandidáta
// pre `pairing_candidate` riadky, ktoré ho ešte nemajú. Design komentár na
// tickete ("Zvolený prístup — existujúcich 1309 kandidátov bez obrázka"):
// cielený backfill namiesto plného re-gatheru (`input_hash` bump) —
// zamietnuté, lebo (a) `input_hash` je "zmenila sa identita produktu?",
// nikdy "má appka všetky assety?", (b) plný re-gather by stál
// query_variants×dodávatelia×throttle na produkt len na doplnenie JEDNÉHO
// poľa, kým cielený fetch stojí PRESNE JEDEN request na produkt, (c)
// re-rankovanie by mohlo (zriedkavo) zvoliť iného `chosen_url` kandidáta.
//
// Karta ukazuje LEN `chosenCandidate` (top-8 panel obrázok nepotrebuje,
// mimo rozsahu tiketu) — scope je preto `pairing_candidate` riadky, ktorých
// `url` sa zhoduje s `pairing_candidate_set.chosen_url` toho istého
// produktu, s `image_url IS NULL`. IDEMPOTENTNÝ (WHERE-om), bezpečné
// spustiť KEDYKOĽVEK znova — nielen jednorazová migrácia, ale trvalý
// nástroj na budúce medzery (markup drift na jednom produkte a pod.).
//
// Zdieľa `runPairingSearch`'s advisory zámok (`PAIRING_SEARCH_RUN_LOCK_KEY`)
// — nikdy nový kľúč — aby sa backfill nikdy nepretínal s nočným gather
// behom nad TÝMI ISTÝMI riadkami (ten by mohol medzitým delete+insert-núť
// presne tie riadky, čo backfill práve aktualizuje).

import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairingCandidates, pairingCandidateSets } from "../../db/schema.js";
import { log } from "../../logger.js";
import { SearchClient } from "./client.js";
import { PAIRING_SEARCH_RUN_LOCK_KEY } from "./constants.js";
import { extractPage } from "./verify.js";

export interface BackfillCandidateImagesError {
  readonly productKey: string;
  readonly url: string;
  readonly message: string;
}

export interface BackfillCandidateImagesResult {
  /** Koľko chosen-kandidátových riadkov bez obrázka backfill našiel. */
  readonly checked: number;
  /** Koľko z nich reálne dostalo obrázok (stránka niesla použiteľný
   *  `og:image` — `checked - updated - failed` je "stránka sa stiahla, ale
   *  žiadny použiteľný obrázok nenašla", nie chyba). */
  readonly updated: number;
  readonly failed: number;
  readonly errors: readonly BackfillCandidateImagesError[];
}

export interface BackfillCandidateImagesOptions {
  readonly db: Database;
  /** Iba pre testy — nahradí skutočný sieťový `SearchClient`. */
  readonly searchClient?: SearchClient;
}

export async function backfillCandidateImages(options: BackfillCandidateImagesOptions): Promise<BackfillCandidateImagesResult> {
  const { db } = options;
  const lockClient = await db.$client.connect();
  try {
    await lockClient.query("select pg_advisory_lock($1)", [PAIRING_SEARCH_RUN_LOCK_KEY]);
    return await backfillCandidateImagesLocked(options);
  } finally {
    await lockClient.query("select pg_advisory_unlock($1)", [PAIRING_SEARCH_RUN_LOCK_KEY]);
    lockClient.release();
  }
}

async function backfillCandidateImagesLocked(options: BackfillCandidateImagesOptions): Promise<BackfillCandidateImagesResult> {
  const { db } = options;
  const client = options.searchClient ?? new SearchClient();

  const rows = await db
    .select({ productKey: pairingCandidates.productKey, url: pairingCandidates.url })
    .from(pairingCandidates)
    .innerJoin(
      pairingCandidateSets,
      and(eq(pairingCandidateSets.productKey, pairingCandidates.productKey), eq(pairingCandidateSets.chosenUrl, pairingCandidates.url)),
    )
    .where(isNull(pairingCandidates.imageUrl));

  let updated = 0;
  const errors: BackfillCandidateImagesError[] = [];

  for (const row of rows) {
    try {
      const html = await client.fetchPage(row.url);
      const { image } = extractPage(html, row.url);
      if (image !== null) {
        await db
          .update(pairingCandidates)
          .set({ imageUrl: image })
          .where(and(eq(pairingCandidates.productKey, row.productKey), eq(pairingCandidates.url, row.url)));
        updated += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(
        { productKey: row.productKey, url: row.url, message },
        "pairing-search: backfill obrázka zlyhal pre kandidáta, pokračujem ďalším",
      );
      errors.push({ productKey: row.productKey, url: row.url, message });
    }
  }

  return { checked: rows.length, updated, failed: errors.length, errors };
}
