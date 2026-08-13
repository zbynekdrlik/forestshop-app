// Trvalé úložisko profesionálneho párovania (issue 387 E3) — návrh
// (https://github.com/zbynekdrlik/forestshop-app/issues/387#issuecomment-
// 5273377438, sekcia "DB schéma"). `pairing_decision` (E6) sa v tomto
// súbore ZÁMERNE NEROBÍ — mimo rozsahu E3.

import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { products } from "./schema-catalog.js";
// `users` sa importuje PRIAMO zo svojho sibling súboru, nikdy cez barrel
// `schema.js` — ten by vytvoril kruhový import (`.claude/rules/database.md`).
import { users } from "./schema-users.js";

export const pairingConfidence = pgEnum("pairing_confidence", ["high", "medium", "low", "none"]);
export const pairingVerdict = pgEnum("pairing_verdict", ["ok", "unsure"]);

// Jeden riadok na PRODUKT — výsledok POSLEDNÉHO gather behu (issue 387 E3's
// `run.ts`). `input_hash` (meno + zoradené external kódy variantov, `input-
// hash.ts`) je to, čo appku robí INKREMENTÁLNOU: gather beh vyberá len
// produkty, ktoré NEMAJÚ tento riadok vôbec, ALEBO ho majú s ROZDIELNYM
// `input_hash` (katalógový import zmenil meno/kódy odvtedy). `verdict`/
// `verdict_checked_at` ostávajú `null` v E3 — vyplní ich AŽ E4 (overenie
// kódu na detaile kandidáta).
export const pairingCandidateSets = pgTable("pairing_candidate_set", {
  productKey: text("product_key")
    .primaryKey()
    .references(() => products.key, { onDelete: "cascade" }),
  gatheredAt: timestamp("gathered_at", { withTimezone: true }).notNull(),
  // Dopyty SKUTOČNE použité pri tomto behu (`buildQueryVariants`'s únia,
  // `gather_candidates`'s `used` — nie `buildQueryLadder`, viď design
  // komentár na tickete) — diagnostika, prečo/ako sa kandidáti našli.
  queries: jsonb("queries").$type<string[]>().notNull(),
  inputHash: text("input_hash").notNull(),
  chosenUrl: text("chosen_url"),
  chosenReason: text("chosen_reason"),
  confidence: pairingConfidence("confidence").notNull(),
  verdict: pairingVerdict("verdict"),
  verdictCheckedAt: timestamp("verdict_checked_at", { withTimezone: true }),
});

// Top-8 kandidátov posledného gather behu — KAŽDÝ gather beh nahradí CELÚ
// množinu kandidátov daného produktu (delete+insert v tej istej transakcii
// ako `pairing_candidate_set` upsert, `run.ts`), nikdy inkrementálny diff —
// kandidáti sú vždy "posledný pohľad na top-8", nie história.
export const pairingCandidates = pgTable(
  "pairing_candidate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Bez `.references()` priamo tu — FK je nižšie explicitne pomenovaná
    // `foreignKey({...})` (review nález: drizzle-ov AUTO-generovaný názov
    // `pairing_candidate_product_key_pairing_candidate_set_product_key_fk`
    // má 69 znakov, nad Postgres-ovým 63-bajtovým `NAMEDATALEN` limitom —
    // Postgres ho TICHO orezáva pri vytvorení, ale `drizzle-kit`'s snapshot
    // JSON si pamätá plný, nikdy-neintrospektovaný 69-znakový názov, takže
    // budúci `db:generate`, ktorý by túto FK menil, by vygeneroval `ALTER
    // TABLE ... DROP CONSTRAINT` na názov, ktorý v živej DB neexistuje).
    productKey: text("product_key").notNull(),
    // Poradie v rámci top-8 (0 = najlepší podľa `rank()`), 0..7.
    position: integer("position").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    // `code`/`price` sú `null` pri parsovaní VÝSLEDKOV VYHĽADÁVANIA (E2's
    // adaptéry ich nikdy nenapĺňajú, presne ako stará appka) — dopĺňa ich
    // AŽ E4's overenie na detaile kandidáta.
    code: text("code"),
    price: numeric("price", { precision: 12, scale: 2 }),
    // Repo konvencia: numeric floaty sa ukladajú cez `numeric` (string na
    // JS strane), nikdy `real`/`doublePrecision` (`.claude/rules/
    // database.md`) — `raw_score` nie je peniaze, ale konzistencia s
    // JEDINÝM float-storage vzorom v celej appke sa dodržiava aj tu.
    rawScore: numeric("raw_score", { precision: 8, scale: 4 }).notNull(),
    codeHit: boolean("code_hit").notNull(),
  },
  (t) => [
    uniqueIndex("pairing_candidate_product_url_uq").on(t.productKey, t.url),
    index("pairing_candidate_product_idx").on(t.productKey),
    foreignKey({
      name: "pairing_candidate_product_key_fk",
      columns: [t.productKey],
      foreignColumns: [pairingCandidateSets.productKey],
    }).onDelete("cascade"),
  ],
);

// Singleton Štart/Stop prepínač — presný vzor `restock_settings`
// (`schema-restock.ts`): ŽIADEN migračný seed riadok, chýbajúci riadok sa v
// `isPairingSearchEnabled` interpretuje ako `false` (fail-closed, appka
// nezačne v noci obiehať dodávateľov, kým ju niekto výslovne nezapne).
export const pairingSearchSettings = pgTable("pairing_search_settings", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

// issue 387 E6 — človekove rozhodnutie o produkte, presne štvorica starej
// appky (`webreview/app.py`'s DECISIONS status hodnoty). Neprítomnosť
// riadku = "nezrevidované" (`pairing-review/queries.ts`'s `unreviewed`
// filter, forward-kompat rozšírené o TENTO stĺpec — design komentár na
// tickete, issue 387 E5). "↩ Vrátiť" = DELETE riadku (nikdy status navyše).
export const pairingDecisionStatus = pgEnum("pairing_decision_status", ["good", "manual", "unavailable", "discontinued"]);

export const pairingDecisions = pgTable(
  "pairing_decision",
  {
    productKey: text("product_key")
      .primaryKey()
      .references(() => products.key, { onDelete: "cascade" }),
    status: pairingDecisionStatus("status").notNull(),
    // `good`/`manual` ⇒ NOT NULL (potvrdená/vybraná dodávateľská URL);
    // `unavailable`/`discontinued` ⇒ vždy NULL (žiadny odkaz, len stav) —
    // vynútené `pairing_decision_url_ck` nižšie.
    url: text("url"),
    // RESTRICT (nie CASCADE/SET NULL) — zmazanie používateľa nesmie ticho
    // stratiť, KTO rozhodol (`.claude/rules/database.md`'s poučenie: FK
    // "set null" pri stĺpci, čo CHECK viaže na iný stav, sa v praxi nikdy
    // neuplatní; tu navyše ide o priamu auditnú stopu, RESTRICT je
    // pravdivejší popis zámeru).
    decidedBy: uuid("decided_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // Business čas TOHTO rozhodnutia (obnovuje sa pri KAŽDOM prepísaní, nie
    // len pri prvom vytvorení riadku — appka nedrží históriu rozhodnutí,
    // len posledné). `updatedAt` nesie v tejto verzii VŽDY tú istú hodnotu
    // ako `decidedAt` (obe stĺpce sa nastavujú v tom istom upserte) —
    // ponechané ako samostatný technický stĺpec (rovnaká konvencia ako
    // `productSupplierLinkOverrides.updatedAt`) len preto, aby prípadný
    // BUDÚCI optimistický zámok (design komentár, zamietnutý variant 1)
    // nevyžadoval ďalšiu migráciu — guard proti súbežnému prepisu je dnes
    // "posledný zápis vyhráva" (`onConflictDoUpdate`, atomický v Postgrese),
    // konflikt sa zaznamenáva SPÄTNE cez audit, nie PREDCHÁDZA.
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    // Nullable — vyplní AŽ E7 (stavový writeback do Shoptetu), keď reálne
    // odošle STAV (unavailable/discontinued) dodávateľovi. Táto etapa ho
    // len VŽDY nuluje pri každom novom/zmenenom rozhodnutí (predošlý sync,
    // ak nejaký bol, sa týkal STARÉHO stavu).
    stateSyncedAt: timestamp("state_synced_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "pairing_decision_url_ck",
      sql`(${t.status} IN ('good','manual') AND ${t.url} IS NOT NULL) OR (${t.status} IN ('unavailable','discontinued') AND ${t.url} IS NULL)`,
    ),
  ],
);
