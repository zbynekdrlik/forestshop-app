import { sql } from "drizzle-orm";
import {
  boolean,
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
import { products, variants } from "./schema-catalog.js";

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

// Odvodené priamo z `enumValues`, nie ručne prepísaná duplicitná únia — nová
// hodnota pridaná do `orderLineState` vyššie sa tak prejaví aj tu bez rizika
// rozídenia (#23, `modules/orders/queries.ts` + `http/orders-routes.ts`).
export type OrderLineState = (typeof orderLineState.enumValues)[number];

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
    // issue 59: Shoptet-ov stav objednávky (napr. "Vybavuje sa"/"Vybavená"),
    // opakovaný na KAŽDOM riadku exportu tej istej objednávky — importer
    // (`modules/orders/ingest.ts`) berie prvý výskyt, rovnaký vzor ako
    // `customerName`/`placedAt`, a OSVIEŽUJE ho pri re-importe (na rozdiel od
    // `comment`/`order_line.state` nižšie, toto pole je VŽDY Shoptetovo,
    // nikdy appkou/manažérom vlastnené). Rozhoduje, či sa objednávka ukáže v
    // "Na objednanie" (`modules/orders/queries.ts` + `modules/orders/
    // open-statuses.ts`). DB `default` je LEN záchranná sieť pre ručne
    // vložené riadky (testy/fixtúry) — produkčný import vždy zapíše
    // skutočnú hodnotu z exportu, nikdy sa nespolieha na tento default.
    statusName: text("status_name").notNull().default("Vybavuje sa"),
    // issue 65: zákaznícky odkaz k objednávke (Shoptet export's `remark`
    // stĺpec — NIE `shopRemark`, ktorý je interná poznámka PREDAJNE a
    // koncepčne duplikuje už existujúce `comment` vyššie; overené naživo na
    // reálnom exporte + `parovanie_produktov/.claude/skills/shoptet/
    // SKILL.md:92`). Je to VŽDY Shoptetovo pole (rovnaký zámer ako
    // `statusName` vyššie, nikdy appkou/manažérom vlastnené na rozdiel od
    // `comment`) — `ingest.ts` ho preto pri re-importe OSVIEŽI. Nepovinný
    // stĺpec exportu (veľa objednávok ho nemá vyplnený), read-only na
    // obrazovke "Na objednanie".
    remark: text("remark"),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("order_placed_at_idx").on(t.placedAt)],
);

// issue 59: ktoré Shoptet stavy sa počítajú ako "objednávka sa ešte
// vybavuje" — jediný nastaviteľný zoznam, ktorý táto appka potrebuje.
// Stará appka (`parovanie_produktov`) má na tom istom mieste ŠTYRI zoznamy
// (`to_order`/`terminal`/`known_open`/`cancelled` + "impact preview" pred
// uložením) — tie ostatné tri existujú LEN kvôli funkciám, ktoré táto appka
// (zatiaľ) nemá vôbec: mazanie starých značiek podľa stavu, pripomienkové
// e-maily zákazníkom, Pošta automatizácia. Kopírovať ich sem by bola
// neaktívna zložitosť bez jediného volajúceho (MVP filozofia, zavrhnutá
// alternatíva v návrhovom komentári na #59) — pribudnú samostatne, ak
// niektorá z tých funkcií niekedy vznikne.
export const orderOpenStatuses = pgTable("order_open_status", {
  statusName: text("status_name").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// E-mailový kontakt na dodávateľa (#31) — nová dátová položka, ktorá v
// starej appke nikdy neexistovala (dodávateľ tam bol len názov, viď komentár
// na tickete). Kľúčovaný PRESNE tým istým reťazcom, aký `queries.ts`'s
// zoskupenie "Na objednanie" už dnes zobrazuje ako `supplier` (vrátane
// zástupného "(bez dodávateľa)"), nie priamo na `product.supplier` (to je
// `null` pre zástupnú skupinu, nie ten čitateľný reťazec) — manažér tak vie
// nastaviť kontakt aj pre skupinu bez dodávateľa, keby to niekedy potreboval.
export const supplierContacts = pgTable("supplier_contact", {
  supplier: text("supplier").primaryKey(),
  email: text("email"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// issue 63: ručné priradenie dodávateľa k produktu, ktorého `product.supplier`
// je `null` (Shoptet export ho nenesie). Kľúčované PRODUKTOM (`product.key`),
// NIE variantom — `product.supplier` je vlastnosť CELÉHO produktu naprieč
// veľkosťami (`schema-catalog.ts`'s komentár k `products.supplier`), presne
// to, čo "platí aj pre ďalšie riadky toho istého tovaru" (ticket) žiada bez
// ďalšieho "rozšír na súrodencov" kroku pri zápise — čítanie ho vyrieši
// automaticky cez JOIN na `productKey`. Samostatná tabuľka (nie priamy zápis
// do `product.supplier`) preto, lebo nočný katalógový re-import
// (`catalog/ingest.ts`) `product.supplier` VŽDY prepíše podľa Shoptet
// exportu — priamy zápis by prežil len do ďalšieho importu. Efektívny
// dodávateľ je všade `coalesce(product.supplier, override.supplier)`
// (`modules/orders/supplier-key.ts`) — override je FALLBACK pre "zatiaľ bez
// dodávateľa", nikdy trvalý pin: keď Shoptet raz dodá reálnu hodnotu, tá
// vyhráva. `ON DELETE CASCADE` — produkt sa reálne nikdy nemaže (rovnaký
// vzor ako `variant`), ale keby niekedy áno, osamotený override riadok bez
// zmyslu nemá dôvod prežiť.
export const productSupplierOverrides = pgTable("product_supplier_override", {
  productKey: text("product_key")
    .primaryKey()
    .references(() => products.key, { onDelete: "cascade" }),
  supplier: text("supplier").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    // issue 60: NEZÁVISLÝ príznak od `state` vyššie — "manažér reálne objednal
    // tento riadok u dodávateľa" (stará appka's samostatný `ORDERED` boolean,
    // oddelený od WAITING/INSTOCK/UNAVAIL, `webreview/static/app.js`'s
    // `saveOrdered`/`markGroupOrdered`). `state`'s `objednane` hodnota je
    // VÝCHODISKOVÝ stav riadku (pozri komentár vyššie + `OrdersSection.tsx`'s
    // `OUTSTANDING_STATE`), NIE potvrdenie objednania — preto appka doteraz
    // nemala žiadne pole na "toto som už objednal", len postupový automat
    // (čaká sa/skladom/nedostupné), ktorý s tým nesúvisí. Manažér môže riadok
    // odškrtnúť ako objednané v ĽUBOVOĽNOM `state`, rovnako ako v starej appke
    // mohli byť ORDERED aj WAITING/INSTOCK/UNAVAIL nezávisle nastavené.
    ordered: boolean("ordered").notNull().default(false),
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
