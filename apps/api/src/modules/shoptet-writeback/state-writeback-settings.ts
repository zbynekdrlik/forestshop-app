import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairingStateWritebackSettings } from "../../db/schema.js";

// issue 387 E7 — Štart/Stop prepínač pre stavový writeback (mení viditeľnosť
// produktov na živom shope). Mirror `pairing-search/settings.ts`.
export const PAIRING_STATE_WRITEBACK_SETTINGS_ID = "default";

/** `true` len keď riadok existuje A `enabled = true` — chýbajúci riadok
 * (žiadny migračný seed) sa berie ako VYPNUTÉ, nikdy ako zapnuté (rovnaká
 * fail-closed disciplína ako `pairing_search_settings`/`restock_settings`:
 * appka nezačne meniť viditeľnosť produktov na živom shope, kým ju niekto
 * výslovne nezapne po prvom naživo overení). */
export async function isStateWritebackEnabled(db: Database): Promise<boolean> {
  const [row] = await db
    .select({ enabled: pairingStateWritebackSettings.enabled })
    .from(pairingStateWritebackSettings)
    .where(eq(pairingStateWritebackSettings.id, PAIRING_STATE_WRITEBACK_SETTINGS_ID));
  return row?.enabled ?? false;
}

export async function setStateWritebackEnabled(db: Database, enabled: boolean, now: Date): Promise<void> {
  await db
    .insert(pairingStateWritebackSettings)
    .values({ id: PAIRING_STATE_WRITEBACK_SETTINGS_ID, enabled, updatedAt: now })
    .onConflictDoUpdate({ target: pairingStateWritebackSettings.id, set: { enabled, updatedAt: now } });
}
