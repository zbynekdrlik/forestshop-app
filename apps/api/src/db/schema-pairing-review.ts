// Trvalé úložisko profesionálneho párovania (issue 387 E3) — návrh
// (https://github.com/zbynekdrlik/forestshop-app/issues/387#issuecomment-
// 5273377438, sekcia "DB schéma"). `pairing_decision` (E6) sa v tomto
// súbore ZÁMERNE NEROBÍ — mimo rozsahu E3.

import { boolean, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { products } from "./schema-catalog.js";

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
    productKey: text("product_key")
      .notNull()
      .references(() => pairingCandidateSets.productKey, { onDelete: "cascade" }),
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
