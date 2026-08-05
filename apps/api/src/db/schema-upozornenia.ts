import { sql } from "drizzle-orm";
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./schema-users.js";

// issue 267: "Upozornenia" — jedna nástenka vecí, ktoré majiteľ musí vybaviť.
// `type` je OTVORENÝ zoznam — `vlastna_poznamka` (majiteľove vlastné
// poznámky, #267) a `nevyzdvihnuta_zasielka` (prvý automatický zdroj, #268:
// `posta-uncollected/run.ts` volá `upsertUpozornenie` priamo zo svojho
// existujúceho denného behu). Ďalší budúci automatický zdroj (#269
// vrátenie) pridá SVOJU hodnotu vlastnou migráciou (`ALTER TYPE ... ADD
// VALUE`, rovnaký vzor ako `nedostupneEmailType`/`.claude/rules/testing.md`'s
// "Nová pgEnum hodnota" past). `source` je NEZÁVISLÝ, navždy 2-hodnotový enum
// — určuje UI schopnosť (len `vlastne` karty majú Upraviť/Zmazať), `type` je
// len farebný štítok.
export const upozornenieType = pgEnum("upozornenie_type", ["vlastna_poznamka", "nevyzdvihnuta_zasielka"]);
export const upozornenieSource = pgEnum("upozornenie_source", ["vlastne", "appka"]);

export const upozornenie = pgTable(
  "upozornenie",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: upozornenieType("type").notNull(),
    source: upozornenieSource("source").notNull(),
    title: text("title").notNull(),
    details: text("details").notNull().default(""),
    // Odkaz priamo na miesto v appke, ktorého sa karta týka (napr.
    // "?tab=orders") — `null` pre vlastné poznámky, ktoré na nič neodkazujú.
    link: text("link"),
    // Dedup kľúč pre AUTOMATICKÉ zdroje (napr. "posta:EF123456789SK") —
    // VLASTNÉ poznámky ho nikdy nenesú (ostáva null). Postgres unique index
    // dovoľuje ľubovoľne veľa NULL hodnôt bez kolízie (rovnaká disciplína ako
    // `nedostupne_state`'s plain-text dedup stĺpce), takže vlastné poznámky
    // si navzájom nekolidujú.
    dedupKey: text("dedup_key"),
    // "Vybaviť do" — nepovinný dátum, ktorý majiteľ zadá pri vlastnej
    // poznámke (alebo ho prinesie automatický zdroj).
    dueAt: timestamp("due_at", { withTimezone: true }),
    // Kým je v budúcnosti, karta zmizne zo zoznamu aj z odznaku (`status.ts`).
    postponedUntil: timestamp("postponed_until", { withTimezone: true }),
    // `null` = ešte nevidené ("Nové"). Nastavuje sa hromadne pri OTVORENÍ
    // záložky (`POST /api/upozornenia/mark-seen`), nie per-karta kliknutím.
    seenAt: timestamp("seen_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // `null` pri vyplnenom `resolvedAt` znamená "vybavené systémom" — #268's
    // `autoResolveByDedupKey` (`upozornenia/service.ts`) ho zámerne
    // NEVYPĹŇA; človek ho vyplní len cez `resolveUpozornenie` (ručné
    // "Vybavené").
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ČIASTOČNÝ unique index — platí len KÝM je riadok nevyriešený
    // (`resolved_at IS NULL`). Bez `.where()` by druhý výskyt toho istého
    // `dedupKey` PO vyriešení prvého (napr. zásielka sa znova vyzdvihne a
    // znova zastaví o mesiac neskôr) narazil na unique-violation namiesto
    // vloženia nového riadku (`upsertUpozornenie`'s zámerné správanie —
    // vyriešený riadok sa NIKDY neobnovuje, dostane VLASTNÝ nový). Nájdené
    // integračným testom PRED mergom, nie odhadom.
    uniqueIndex("upozornenie_dedup_key_uq").on(t.dedupKey).where(sql`resolved_at IS NULL`),
    index("upozornenie_resolved_at_idx").on(t.resolvedAt),
  ],
);
