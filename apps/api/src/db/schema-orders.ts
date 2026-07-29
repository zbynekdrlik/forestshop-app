import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { variants } from "./schema-catalog.js";

// Stav riadku objednávky ako automat (návrh, kap. 4): objednané → čaká sa →
// skladom → nedostupné. Zámerne PROSTÝ enum na `order_line.state`, nie
// samostatná (konfigurovateľná) tabuľka — EN spresnenie v #20 explicitne žiada
// "proper enum"; konfigurovateľnosť stavov (stará appka) by bez API na jej
// zmenu (mimo scope, #21+) bola špekulatívna zložitosť navyše. Hodnoty bez
// diakritiky, rovnaký vzor ako `user_role` (`manazer`, `sef`, `citanie`).
export const orderLineState = pgEnum("order_line_state", [
  "objednane",
  "caka_sa",
  "skladom",
  "nedostupne",
]);

// Identita objednávky je Shoptet-ovo číslo objednávky (`externalOrderId`) —
// budúci importer (#21) ho potrebuje na idempotentné párovanie, rovnaký vzor
// ako `catalog_snapshot.content_sha256` unique. Cena/mena na riadku sa
// ZÁMERNE nepridáva teraz (viď komentár k `orderLines` nižšie) — pozri
// zamietnutú alternatívu #2 v návrhovom komentári na tickete.
export const orders = pgTable(
  "order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    externalOrderId: text("external_order_id").notNull().unique(),
    customerName: text("customer_name").notNull(),
    // Manažérov voľný komentár k objednávke (stará appka, obrazovka "Na
    // objednanie" — potvrdené v docs/stara-appka-inventar.md, bod 1).
    comment: text("comment"),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("order_placed_at_idx").on(t.placedAt)],
);

export const orderLines = pgTable(
  "order_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    // FK na existujúcu katalógovú tabuľku `variant.code` (identita variantu je
    // kód, viď schema-catalog.ts). Bez `onDelete` — varianty sa nikdy
    // nemažú (len `missingSince`), rovnaký vzor ako
    // `products.last_seen_snapshot_id`. Zoskupenie podľa dodávateľa pre
    // obrazovku "Na objednanie" ide cez `variant.product_key → product.supplier`,
    // netreba duplicitné pole na riadku.
    variantCode: text("variant_code")
      .notNull()
      .references(() => variants.code),
    quantity: integer("quantity").notNull(),
    state: orderLineState("state").notNull().default("objednane"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("order_line_order_idx").on(t.orderId),
    index("order_line_variant_idx").on(t.variantCode),
    index("order_line_state_idx").on(t.state),
    check("order_line_quantity_positive_ck", sql`${t.quantity} > 0`),
    // Importer (#21) potrebuje idempotentný upsert po dvojici objednávka+variant
    // — Shoptet niekedy vráti ten istý produkt v tej istej objednávke na dvoch
    // riadkoch (rozdelené množstvo), ktoré importer sčíta do JEDNÉHO riadku.
    // Bez tohto indexu by `onConflictDoUpdate` nemal na čom rozpoznať re-import
    // toho istého riadku a duplicitne by vkladal nové UUID pri každom behu.
    uniqueIndex("order_line_order_variant_uq").on(t.orderId, t.variantCode),
  ],
);
