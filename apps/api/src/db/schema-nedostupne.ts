import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// issue 176: "Nedostupné tovary" — dva e-mailové typy (bez náhrady / s
// návrhom náhrady), rovnaký zámer ako stará appka's `nedostupne.py`'s
// `EMAIL_TYPES` (`TYPE_UNAVAILABLE`/`TYPE_ALTERNATIVE`).
export const nedostupneEmailType = pgEnum("nedostupne_email_type", ["nedostupne", "alternativa"]);

// Dedup/odoslané stav — PLAIN-TEXT kľúčovaný (`order_code`/`variant_code`,
// ŽIADNY FK), rovnaký vzor ako `order_reminder_state`/`posta_uncollected_
// state` (`.claude/rules/order-reminder.md`). Na rozdiel od tých dvoch NEMÁ
// tento modul žiadny naplánovaný beh ani `enabled` prepínač — obrazovka je
// VŽDY živo čítaná priamo z `order_line`/`order` (žiadny `job_run.detail`
// cache), takže táto tabuľka nesie LEN "čo už bolo odoslané", nikdy
// zobrazovací stav. Jeden riadok = jeden úspešne odoslaný e-mail pre presne
// (objednávka, variant, typ) — nikdy sa neprepisuje, nikdy sa nemaže (dôkaz
// "tento zákazník toto UŽ dostal", navždy).
export const nedostupneState = pgTable(
  "nedostupne_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderCode: text("order_code").notNull(),
    variantCode: text("variant_code").notNull(),
    emailType: nedostupneEmailType("email_type").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("nedostupne_state_order_variant_type_uq").on(t.orderCode, t.variantCode, t.emailType),
  ],
);
