import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderReminderSettings } from "../../db/schema.js";

// Singleton riadok (`schema-order-reminder.ts`) — jediný, pevný `id`.
export const ORDER_REMINDER_SETTINGS_ID = "default";

/** `true` len keď riadok existuje A `enabled = true` — chýbajúci riadok
 * (stav pred prvou migráciou/testom, ktorý zabudol reseed) sa berie ako
 * VYPNUTÉ, nikdy ako zapnuté (rovnaká bezpečnostná disciplína ako #172 —
 * chýbajúci dôkaz nikdy neznamená "pošli mail"). */
export async function isOrderReminderEnabled(db: Database): Promise<boolean> {
  const [row] = await db
    .select({ enabled: orderReminderSettings.enabled })
    .from(orderReminderSettings)
    .where(eq(orderReminderSettings.id, ORDER_REMINDER_SETTINGS_ID));
  return row?.enabled ?? false;
}

export async function setOrderReminderEnabled(db: Database, enabled: boolean, now: Date): Promise<void> {
  await db
    .insert(orderReminderSettings)
    .values({ id: ORDER_REMINDER_SETTINGS_ID, enabled, updatedAt: now })
    .onConflictDoUpdate({
      target: orderReminderSettings.id,
      set: { enabled, updatedAt: now },
    });
}
