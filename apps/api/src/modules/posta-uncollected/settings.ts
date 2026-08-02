import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { postaUncollectedSettings } from "../../db/schema.js";

// Singleton riadok (`schema-posta-uncollected.ts`) — jediný, pevný `id`.
export const POSTA_UNCOLLECTED_SETTINGS_ID = "default";

/** `true` len keď riadok existuje A `enabled = true` — chýbajúci riadok
 * (stav pred prvou migráciou/testom, ktorý zabudol reseed) sa berie ako
 * VYPNUTÉ, nikdy ako zapnuté (bezpečnostná disciplína ticketu: chýbajúci
 * dôkaz nikdy neznamená "pošli mail"). */
export async function isPostaUncollectedEnabled(db: Database): Promise<boolean> {
  const [row] = await db
    .select({ enabled: postaUncollectedSettings.enabled })
    .from(postaUncollectedSettings)
    .where(eq(postaUncollectedSettings.id, POSTA_UNCOLLECTED_SETTINGS_ID));
  return row?.enabled ?? false;
}

export async function setPostaUncollectedEnabled(db: Database, enabled: boolean, now: Date): Promise<void> {
  await db
    .insert(postaUncollectedSettings)
    .values({ id: POSTA_UNCOLLECTED_SETTINGS_ID, enabled, updatedAt: now })
    .onConflictDoUpdate({
      target: postaUncollectedSettings.id,
      set: { enabled, updatedAt: now },
    });
}
