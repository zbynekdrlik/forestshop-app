import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { pairingSearchSettings } from "../../db/schema.js";
import { PAIRING_SEARCH_SETTINGS_ID } from "./constants.js";

/** `true` len keď riadok existuje A `enabled = true` — chýbajúci riadok
 * (žiadny migračný seed, presne ako `restock_settings`) sa berie ako
 * VYPNUTÉ, nikdy ako zapnuté (rovnaká fail-closed disciplína ako
 * `restock`/`posta-uncollected`: appka nezačne v noci obiehať dodávateľov,
 * kým ju niekto výslovne nezapne). */
export async function isPairingSearchEnabled(db: Database): Promise<boolean> {
  const [row] = await db
    .select({ enabled: pairingSearchSettings.enabled })
    .from(pairingSearchSettings)
    .where(eq(pairingSearchSettings.id, PAIRING_SEARCH_SETTINGS_ID));
  return row?.enabled ?? false;
}

export async function setPairingSearchEnabled(db: Database, enabled: boolean, now: Date): Promise<void> {
  await db
    .insert(pairingSearchSettings)
    .values({ id: PAIRING_SEARCH_SETTINGS_ID, enabled, updatedAt: now })
    .onConflictDoUpdate({ target: pairingSearchSettings.id, set: { enabled, updatedAt: now } });
}
