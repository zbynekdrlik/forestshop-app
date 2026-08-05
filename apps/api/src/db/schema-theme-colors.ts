import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./schema-users.js";

// issue 264: farby bublinek dodávateľov (issue 263) upraviteľné majiteľom.
// Rovnaký vzor ako `mail_template` (issue 192, `.claude/rules/mail-
// templates.md`): riadok tu existuje LEN pre farbu, ktorú majiteľ NAOZAJ
// zmenil — chýbajúci riadok znamená "použi predvolenú hodnotu z kódu"
// (`modules/theme-colors/registry.ts`). "Obnoviť predvolené" je preto
// obyčajné zmazanie riadkov, presne ako mail-template reset, a predvolené
// hodnoty nemôžu zastarať oproti kódu (kopírovanie predvolených hodnôt do
// databázy migráciou by presne to spôsobilo).
//
// Šesť SAMOSTATNÝCH riadkov (nie jeden JSON blob so všetkými farbami) — každá
// farba má vlastný `updatedAt`/`updatedByUserId`, takže pridanie ďalšej
// upraviteľnej farby v budúcnosti nepotrebuje schémovú zmenu, len nový kľúč
// v registri.
export const themeColors = pgTable("theme_color", {
  // Kľúč CSS premennej BEZ `--` prefixu (napr. "chip-done-bg") —
  // `registry.ts`'s `THEME_COLOR_KEYS`. Text, nie enum: pribudnutie ďalšej
  // upraviteľnej farby je zmena v kóde, nie migrácia.
  key: text("key").primaryKey(),
  // Hex farba vo tvare "#rrggbb" — validované v `registry.ts` PRED zápisom,
  // nikdy sa nespolieha na DB constraint.
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
});
