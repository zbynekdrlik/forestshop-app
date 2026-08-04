import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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

// issue 238: majiteľ, doslovne "nechcem aby to uvádzalo tieto náhrady - je to
// blbosť, to sú súvisiace produkty - nie podobné, nie náhrady" — automatický
// návrh (`product.related_codes`, vyššie zavrhnutý celý mechanizmus) sa ruší
// a nahrádza RUČNÝMI odkazmi, ktoré majiteľ sám vloží. Kľúčovaná
// `variant_code` (PLAIN text, BEZ FK — rovnaká konvencia ako `nedostupne_state`
// vyššie), NIE dvojicou (objednávka, variant): obrazovka zoskupuje podľa
// VARIANTU (`NedostupneGroup`), majiteľov nákres dáva pole PRI KAŽDOM TOVARE
// (skupina), nie pri každom čakajúcom zákazníckom riadku — inak by musel ten
// istý odkaz vpisovať znova pre každú objednávku toho istého tovaru. ŽIADNY
// unique index na `variant_code` — viac riadkov s rovnakým kódom = viac
// liniek na ten istý tovar, presne požiadavka "musí sa dať vložiť viac".
// Prežije nočný katalógový reimport rovnako ako `nedostupne_state`/
// `mail_template` — import sa tejto tabuľky vôbec nedotýka (`product.
// related_codes`/jeho import OSTÁVA nedotknutý, len appka ho už nikde
// nečíta — zámerné mimo scope, viď návrhový komentár na tickete).
export const nedostupneReplacementLinks = pgTable(
  "nedostupne_replacement_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    variantCode: text("variant_code").notNull(),
    url: text("url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("nedostupne_replacement_link_variant_idx").on(t.variantCode)],
);
