import { index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./schema-users.js";

// issue 192: upravené znenia e-mailov. Riadok tu existuje LEN pre šablónu,
// ktorú majiteľ naozaj zmenil — chýbajúci riadok znamená "použi pôvodné
// znenie z kódu" (`modules/mail-templates/registry.ts`). Preto je "vrátiť
// pôvodné znenie" obyčajné zmazanie riadku a pôvodné texty nemôžu zastarať
// oproti kódu (kopírovanie pôvodných znení do databázy pri nasadení by presne
// to spôsobilo).
export const mailTemplates = pgTable("mail_template", {
  // Kľúč druhu e-mailu (`MAIL_TEMPLATE_KEYS`) — text, nie enum: pribudnutie
  // ďalšieho druhu e-mailu je potom zmena v kóde, nie migrácia.
  key: text("key").primaryKey(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
});

export const mailTemplateAction = pgEnum("mail_template_action", ["save", "reset"]);

// História zmien (ticket: "kto a kedy text zmenil"). Append-only, nikdy sa
// nemaže ani neprepisuje — aj vrátenie pôvodného znenia je záznam.
export const mailTemplateHistory = pgTable(
  "mail_template_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    action: mailTemplateAction("action").notNull(),
    // Znenie PLATNÉ PO tejto zmene — pri vrátení pôvodného sa uloží pôvodné
    // znenie z kódu, aby sa história dala čítať bez znalosti verzie kódu.
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
    changedByUserId: uuid("changed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("mail_template_history_key_idx").on(t.key, t.changedAt)],
);
