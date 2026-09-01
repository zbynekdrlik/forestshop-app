import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { nedostupneResolved } from "../../db/schema.js";

// issue 531: ručné označenie „vyriešené" pri karte produktu (Štěpán: „nič
// ďalšie sa nestane, len sa to označí"). PRÍTOMNOSŤ riadku = vyriešené, žiadny
// riadok = nevyriešené — kľúčované `variant_code` (PLAIN, bez FK, UNIQUE index),
// rovnaká konvencia ako `nedostupne_state`/`nedostupne_replacement_link`. Toggle
// je idempotentný v OBOCH smeroch (INSERT ... ON CONFLICT DO NOTHING / DELETE),
// takže žiadny advisory zámok netreba — na rozdiel od `nedostupne_state`, kde
// zámok chráni pred dvojitým ODOSLANÍM e-mailu; tu je to len boolean.

/** Množina VŠETKÝCH variantov označených ako „vyriešené" — `queries.ts`'s
 * zoznam ich potrebuje naraz (jeden dopyt namiesto N kontrol na skupinu),
 * rovnaký vzor ako `loadSentNedostupne`. */
export async function loadResolvedVariants(db: Pick<Database, "select">): Promise<ReadonlySet<string>> {
  const rows = await db.select({ variantCode: nedostupneResolved.variantCode }).from(nedostupneResolved);
  return new Set(rows.map((r) => r.variantCode));
}

/** Nastaví želaný stav pre presne tento variant — idempotentné v oboch
 * smeroch. `resolved=true` → INSERT s `ON CONFLICT DO NOTHING` (dvojklik/súbeh
 * neurobí druhý riadok, UNIQUE index to aj tak zaručuje); `resolved=false` →
 * DELETE podľa `variant_code` (neexistujúci riadok je neškodný no-op). */
export async function setVariantResolved(db: Pick<Database, "insert" | "delete">, variantCode: string, resolved: boolean, now: Date): Promise<void> {
  if (resolved) {
    await db.insert(nedostupneResolved).values({ variantCode, resolvedAt: now }).onConflictDoNothing({ target: nedostupneResolved.variantCode });
  } else {
    await db.delete(nedostupneResolved).where(eq(nedostupneResolved.variantCode, variantCode));
  }
}
