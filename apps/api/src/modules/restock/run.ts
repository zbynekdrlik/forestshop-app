// Beh automatizácie "Vypredané → Skladom" (issue 213).
//
// Toto je jediná automatizácia v appke, ktorá sama od seba ZAPISUJE do
// e-shopu. Preto: vlastný Štart/Stop prepínač, strop na počet prepnutí,
// advisory zámok proti dvom súbežným behom a záznam o KAŽDOM prepnutí.

import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { restockEvents, restockSettings } from "../../db/schema.js";
import type { ShoptetImportConfig } from "../shoptet-writeback/config.js";
import { buildRestockCsv } from "../shoptet-writeback/csv.js";
import { runShoptetImportIsolated } from "../shoptet-writeback/playwright-import.js";
import {
  AVAILABILITY_IN_STOCK_TEXT,
  MAX_PER_RUN,
  RESTOCK_RUN_LOCK_KEY,
  RESTOCK_SETTINGS_ID,
} from "./constants.js";
import { selectRestockCandidates, type RestockCandidate } from "./queries.js";

export type RestockRunResult =
  | { readonly status: "nothing_to_do"; readonly overLimit: 0 }
  | {
      readonly status: "ok";
      readonly switched: number;
      readonly overLimit: number;
      readonly codes: readonly string[];
    }
  | {
      readonly status: "failed";
      readonly attempted: number;
      readonly overLimit: number;
      readonly errorDetail: string;
    };

export interface RunRestockOptions {
  readonly db: Database;
  readonly now: Date;
  readonly config: ShoptetImportConfig;
  /** Iba pre testy — nahradí skutočný Playwright zápis do Shoptetu. */
  readonly importToShoptet?: typeof runShoptetImportIsolated;
  readonly limit?: number;
}

export async function runRestock(options: RunRestockOptions): Promise<RestockRunResult> {
  const { db } = options;
  const lockClient = await db.$client.connect();
  try {
    await lockClient.query("select pg_advisory_lock($1)", [RESTOCK_RUN_LOCK_KEY]);
    return await runRestockLocked(options);
  } finally {
    await lockClient.query("select pg_advisory_unlock($1)", [RESTOCK_RUN_LOCK_KEY]);
    lockClient.release();
  }
}

async function runRestockLocked(options: RunRestockOptions): Promise<RestockRunResult> {
  const { db, now, config } = options;
  const importToShoptet = options.importToShoptet ?? runShoptetImportIsolated;
  const limit = options.limit ?? MAX_PER_RUN;

  const { picked, overLimit } = await selectRestockCandidates(db, now, limit);
  if (picked.length === 0) return { status: "nothing_to_do", overLimit: 0 };

  // OBIDVE polia dostupnosti naraz — Shoptet vyberá jedno z nich podľa zásoby,
  // takže zápis len do jedného by nechal zákazníkovi svietiť to druhé (overené
  // v ostrej prevádzke starej appky 14. 7. 2026). Zásoba sa zámerne nezapisuje
  // vôbec (issue 219) — majiteľ ju v Shoptete neudržiava.
  const csv = buildRestockCsv(
    picked.map((candidate) => ({
      code: candidate.variantCode,
      pairCode: candidate.pairCode ?? "",
      availabilityInStock: AVAILABILITY_IN_STOCK_TEXT,
      availabilityOutOfStock: AVAILABILITY_IN_STOCK_TEXT,
    })),
  );

  const outcome = await importToShoptet({ config, csv, expectedRows: picked.length });
  if (!outcome.ok) {
    // Nezapisuje sa ŽIADNY záznam o prepnutí — import je všetko-alebo-nič,
    // takže tvrdiť, že sa niečo preplo, by bola lož. Kandidáti ostávajú
    // kandidátmi a ďalší beh to skúsi znova.
    return {
      status: "failed",
      attempted: picked.length,
      overLimit,
      errorDetail: outcome.errorDetail ?? "Import do Shoptetu zlyhal bez bližšieho popisu.",
    };
  }

  await recordEvents(db, now, picked);
  return {
    status: "ok",
    switched: picked.length,
    overLimit,
    codes: picked.map((candidate) => candidate.variantCode),
  };
}

async function recordEvents(db: Database, now: Date, picked: readonly RestockCandidate[]): Promise<void> {
  await db.insert(restockEvents).values(
    picked.map((candidate) => ({
      at: now,
      variantCode: candidate.variantCode,
      pairCode: candidate.pairCode,
      productName: candidate.productName,
      supplier: candidate.supplier,
      supplierLink: candidate.supplierLink,
      supplierAvailabilityText: candidate.supplierAvailabilityText,
      supplierPrice: candidate.supplierPrice,
      confirmedAt: candidate.confirmedAt,
    })),
  );
}

/** `true` len keď riadok existuje A `enabled = true` — chýbajúci riadok sa
 * berie ako VYPNUTÉ, nikdy ako zapnuté (rovnaká fail-closed disciplína ako
 * `posta-uncollected/settings.ts`: chýbajúci dôkaz nikdy neznamená „zapisuj
 * do e-shopu"). */
export async function isRestockEnabled(db: Database): Promise<boolean> {
  const [row] = await db
    .select({ enabled: restockSettings.enabled })
    .from(restockSettings)
    .where(eq(restockSettings.id, RESTOCK_SETTINGS_ID));
  return row?.enabled ?? false;
}

export async function setRestockEnabled(db: Database, enabled: boolean, now: Date): Promise<void> {
  await db
    .insert(restockSettings)
    .values({ id: RESTOCK_SETTINGS_ID, enabled, updatedAt: now })
    .onConflictDoUpdate({ target: restockSettings.id, set: { enabled, updatedAt: now } });
}
