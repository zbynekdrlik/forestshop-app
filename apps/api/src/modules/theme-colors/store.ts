import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { themeColors, users } from "../../db/schema.js";
import { THEME_COLOR_KEYS, THEME_COLOR_KINDS, type ThemeColorKey, validateThemeColorValues } from "./registry.js";

// issue 264: čítanie/zápis/reset upravených farieb bublinek dodávateľov.
// Rovnaká štruktúra ako `modules/mail-templates/store.ts` (issue 192).

export interface ResolvedThemeColor {
  readonly key: ThemeColorKey;
  readonly label: string;
  readonly value: string;
  readonly defaultValue: string;
  /** `false` = platí predvolená hodnota z kódu (v databáze nie je žiadny riadok). */
  readonly isCustomized: boolean;
  readonly updatedAt: Date | null;
  readonly updatedByName: string | null;
}

export async function listThemeColors(db: Database): Promise<readonly ResolvedThemeColor[]> {
  const rows = await db
    .select({
      key: themeColors.key,
      value: themeColors.value,
      updatedAt: themeColors.updatedAt,
      updatedByName: users.displayName,
    })
    .from(themeColors)
    .leftJoin(users, eq(users.id, themeColors.updatedByUserId));
  const byKey = new Map(rows.map((r) => [r.key, r]));

  return THEME_COLOR_KEYS.map((key) => {
    const kind = THEME_COLOR_KINDS[key];
    const row = byKey.get(key);
    if (row === undefined) {
      return {
        key,
        label: kind.label,
        value: kind.defaultValue,
        defaultValue: kind.defaultValue,
        isCustomized: false,
        updatedAt: null,
        updatedByName: null,
      };
    }
    return {
      key,
      label: kind.label,
      value: row.value,
      defaultValue: kind.defaultValue,
      isCustomized: true,
      updatedAt: row.updatedAt,
      updatedByName: row.updatedByName,
    };
  });
}

export type SaveThemeColorsResult = { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] };

/** Uloží všetkých šesť farieb naraz (all-or-nothing) — kontrola beží PRED
 * zápisom, takže čo i len jeden neplatný kód farby neuloží ANI JEDNU zmenu. */
export async function saveThemeColors(
  db: Database,
  input: { readonly values: Readonly<Record<string, string>>; readonly userId: string; readonly now: Date },
): Promise<SaveThemeColorsResult> {
  const errors = validateThemeColorValues(input.values);
  if (errors.length > 0) return { ok: false, errors };

  await db.transaction(async (tx) => {
    for (const key of THEME_COLOR_KEYS) {
      const value = input.values[key];
      if (value === undefined) continue; // unreachable — validateThemeColorValues already required every key
      await tx
        .insert(themeColors)
        .values({ key, value, updatedAt: input.now, updatedByUserId: input.userId })
        .onConflictDoUpdate({
          target: themeColors.key,
          set: { value, updatedAt: input.now, updatedByUserId: input.userId },
        });
    }
  });
  return { ok: true };
}

/** Vráti predvolené farby = zmaže všetky riadky. */
export async function resetThemeColors(db: Database): Promise<void> {
  await db.delete(themeColors);
}
