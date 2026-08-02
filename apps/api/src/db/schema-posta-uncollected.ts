import { boolean, date, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// issue 172: "Nevyzdvihnuté zásielky" (Pošta SK) — Štart/Stop prepínač.
// JEDEN singleton riadok (pevné `id = 'default'`, nikdy druhý riadok), aby
// appka mala presne jedno miesto pravdy "je táto automatizácia zapnutá".
// Migrácia seeduje tento riadok s `enabled = false` — nasadenie preto
// FYZICKY nemôže poslať e-mail, kým ho majiteľ sám ručne nezapne (ticket's
// jediná bezpečnostná podmienka, `.claude/rules/…`'s "žiadny e-mail bez
// zásahu človeka"). Tento flag gate-uje LEN naplánovaný denný beh
// (`scheduler/jobs.ts`'s `postaUncollectedJob` ho skontroluje PRED behom
// business logiky) — "Spustiť teraz" volá tú istú funkciu priamo, bez
// ohľadu na tento flag, presne ako stará appka (`automation_runner.py`'s
// `run_now`: "runs even when disabled — an explicit manager action").
export const postaUncollectedSettings = pgTable("posta_uncollected_settings", {
  id: text("id").primaryKey().default("default"),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Eskalačný stav PER OBJEDNÁVKA (nahrádza starej appky `posta_uncollected
// .json`) — koľko e-mailov už bolo poslaných, kedy naposledy, a cache
// TERMINÁLNEHO stavu sledovania (#222 v starej appke: "doručené"/"prevzaté
// na pošte" sa už nemení, netreba ho znova pýtať 7 dní, viď
// `modules/posta-uncollected/logic.ts`'s `TERMINAL_STATE_CODES`). Kľúčované
// KÓDOM OBJEDNÁVKY (nie číslom zásielky) — rovnaký kľúč, aký stará appka's
// JSON store používala (`evaluate_shipment`'s `esc.get(s["code"], "")`),
// lebo jedna objednávka nesie jedno číslo zásielky. Riadky mimo 30-dňové
// okno sa pri každom behu VYMAŽÚ (rovnaký zámer ako stará appka's krok
// "Vyčistí staré záznamy… ktoré už vypadli z 30-dňového okna").
export const postaUncollectedState = pgTable("posta_uncollected_state", {
  orderCode: text("order_code").primaryKey(),
  notifyCount: integer("notify_count").notNull().default(0),
  lastSentAt: date("last_sent_at"),
  terminalState: text("terminal_state"),
  terminalAt: date("terminal_at"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
