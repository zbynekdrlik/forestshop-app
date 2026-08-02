import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// issue 173: "Pripomienky objednávok" — Štart/Stop prepínač, rovnaký tvar ako
// #172's `posta_uncollected_settings` (JEDEN singleton riadok, pevné
// `id = 'default'`). Migrácia seeduje tento riadok s `enabled = false` —
// nasadenie preto FYZICKY nemôže poslať e-mail zákazníkovi, kým ho majiteľ
// sám ručne nezapne (majiteľov komentár na tickete, jediná bezpečnostná
// podmienka). Tento flag gate-uje LEN naplánovaný denný beh
// (`scheduler/jobs.ts`'s `orderReminderJob`) — "Spustiť teraz" aj ručné
// per-riadkové akcie ("▶ Poslať pripomienku"/"✓ Kontaktované") volajú business
// logiku PRIAMO, bez ohľadu na tento flag, presne ako #172's `run_now`.
export const orderReminderSettings = pgTable("order_reminder_settings", {
  id: text("id").primaryKey().default("default"),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Eskalačný stav PER OBJEDNÁVKA (rovnaký zámer ako #172's
// `posta_uncollected_state`, ale MAX JEDEN e-mail, nikdy kadencia) —
// `fingerprint` = `placedAt|shopRemark` (rovnaký zámer ako stará appka's
// `order_fingerprint`, `orders_reminder.py`) je to, čo rozhoduje, či sa
// objednávka pri nezmenenom stave znova prehodnocuje (ticket: "objednávka,
// ktorá už bola vybavená a odvtedy sa jej dátum ani poznámka nezmenili, sa
// znovu nespracúva"). `resolution` a `resolvedBy` sú ZÁMERNE dva samostatné
// stĺpce (nie jeden kombinovaný enum) — ticketova poučka zo starej appky
// ("ľudské rozhodnutie sa pripísalo stroju") sa tu rieši štrukturálne:
// `resolvedBy` sa nikdy neodvodzuje, vždy sa zapisuje explicitne pri zápise
// `resolution`.
export const orderReminderState = pgTable("order_reminder_state", {
  orderCode: text("order_code").primaryKey(),
  fingerprint: text("fingerprint").notNull(),
  // null = ešte nevyriešené (stále eligible na prehodnotenie/AI/mail).
  // 'contacted' = zákazník bol už kontaktovaný (AI alebo ručne), e-mail sa
  // NEPOSIELA. 'emailed' = pripomienkový e-mail bol odoslaný (max raz, navždy).
  resolution: text("resolution"),
  // null (nevyriešené) | 'ai' | 'manual' — kto o výsledku rozhodol, nikdy
  // odvodené z `resolution` samotného.
  resolvedBy: text("resolved_by"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
