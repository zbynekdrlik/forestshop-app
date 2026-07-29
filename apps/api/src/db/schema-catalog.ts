import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const snapshotVerdict = pgEnum("snapshot_verdict", ["accepted", "rejected"]);
export const variantState = pgEnum("variant_state", ["sellable", "out_of_stock", "discontinued"]);
export const ingestIssueKind = pgEnum("ingest_issue_kind", [
  "empty_code",
  "empty_guid",
  "duplicate_code",
  "invalid_money",
  "missing_currency",
  "invalid_stock",
  "product_name_conflict",
]);

// Každé stiahnutie exportu — aj odmietnuté. Riadky sa nikdy nemažú (varianty a
// produkty na ne majú FK „naposledy videný v"), maže sa nanajvýš uložený surový
// súbor na disku, a vtedy sa `raw_path` nastaví na NULL (viď Task 8).
export const catalogSnapshots = pgTable(
  "catalog_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    sourceLabel: text("source_label").notNull(),
    contentSha256: text("content_sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    rowCount: integer("row_count").notNull(),
    columns: jsonb("columns").$type<string[]>().notNull(),
    verdict: snapshotVerdict("verdict").notNull(),
    rejectionReason: text("rejection_reason"),
    rawPath: text("raw_path"),
    variantCount: integer("variant_count"),
    productCount: integer("product_count"),
    issueCount: integer("issue_count"),
  },
  (t) => [
    index("catalog_snapshot_fetched_at_idx").on(t.fetchedAt),
    // Idempotencia: tie isté bajty sa druhýkrát neprijmú. Odmietnuté snapshoty
    // index zámerne nepokrýva — prázdny export sa môže stiahnuť opakovane a každý
    // taký pokus má zostať zapísaný.
    uniqueIndex("catalog_snapshot_accepted_sha_uq")
      .on(t.contentSha256)
      .where(sql`${t.verdict} = 'accepted'`),
    check(
      "catalog_snapshot_reason_ck",
      sql`(${t.verdict} = 'rejected') = (${t.rejectionReason} IS NOT NULL)`,
    ),
  ],
);

// Identita produktu je export's `guid` (task-5-fix-1, review CRITICAL #1) —
// stabilný identifikátor zo Shoptetu, jeden na produkt, nesený na každom riadku.
// `key` PRIMÁRNE nesie práve `guid`. Predtým to bola časť `code` pred prvou
// lomkou, čo bolo v oboch smeroch chybné: zlučovalo úplne nesúvisiace produkty
// zdieľajúce ten istý prefix (na reálnom exporte 282 produktov pod prefixom
// "997") a zároveň ticho rozdeľovalo jeden produkt naprieč viacerými kľúčmi
// (napr. "B13/S" a "B23/S", ten istý `guid`, iný prefix). `pairCode` sa na
// identitu použiť nedá — je to len poradové číslo od Shoptetu, prideľované
// nanovo pri každom exporte.
export const products = pgTable(
  "product",
  {
    key: text("key").primaryKey(),
    name: text("name").notNull(),
    supplier: text("supplier"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    lastSeenSnapshotId: uuid("last_seen_snapshot_id")
      .notNull()
      .references(() => catalogSnapshots.id),
  },
  (t) => [index("product_supplier_idx").on(t.supplier)],
);

export const variants = pgTable(
  "variant",
  {
    // `code` (napr. "40237/3XL") JE identita variantu. `pairCode` je len poradové
    // číslo od Shoptetu a pri ~2 700 jednovariantných produktoch je prázdne, takže
    // sa ukladá ako pozorovaná vlastnosť, nikdy ako kľúč.
    code: text("code").primaryKey(),
    // FK na `product.key`, teda na `guid` — pozri komentár pri `products` vyššie.
    productKey: text("product_key")
      .notNull()
      .references(() => products.key, { onDelete: "cascade" }),
    // Ten istý `guid` ako `productKey`, ale uložený PRIAMO na riadku variantu,
    // nezávisle od FK. Surový identifikátor zo zdroja sa nedá spätne
    // zrekonštruovať z ničoho iného v databáze — ak by sa niekedy menil model
    // zoskupovania produktov (to, na čo `productKey` odkazuje), tento stĺpec
    // zostáva nedotknutým dôkazom pôvodnej hodnoty z exportu, rovnaká filozofia
    // ako gzipnuté surové bajty v `raw-store.ts`.
    guid: text("guid").notNull(),
    sizeLabel: text("size_label"),
    pairCode: text("pair_code"),
    name: text("name").notNull(),
    currency: text("currency"),
    price: numeric("price", { precision: 12, scale: 2 }),
    standardPrice: numeric("standard_price", { precision: 12, scale: 2 }),
    purchasePrice: numeric("purchase_price", { precision: 12, scale: 2 }),
    actionPrice: numeric("action_price", { precision: 12, scale: 2 }),
    actionFrom: date("action_from"),
    actionUntil: date("action_until"),
    percentVat: numeric("percent_vat", { precision: 5, scale: 2 }),
    includingVat: boolean("including_vat"),
    stock: integer("stock").notNull(),
    availabilityInStockText: text("availability_in_stock_text").notNull(),
    availabilityOutOfStockText: text("availability_out_of_stock_text").notNull(),
    availabilityText: text("availability_text").notNull(),
    productVisibility: text("product_visibility").notNull(),
    state: variantState("state").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    lastSeenSnapshotId: uuid("last_seen_snapshot_id")
      .notNull()
      .references(() => catalogSnapshots.id),
    // Variant, ktorý zmizol z exportu, sa NEMAŽE — len sa označí, odkedy chýba.
    missingSince: timestamp("missing_since", { withTimezone: true }),
  },
  (t) => [
    index("variant_product_idx").on(t.productKey),
    index("variant_guid_idx").on(t.guid),
    index("variant_state_idx").on(t.state),
    index("variant_name_idx").on(t.name),
    // „Suma bez meny neexistuje" (návrh, kap. 4) vynútené databázou, nie kódom.
    // Prázdny reťazec sa počíta rovnako prísne ako NULL — `'' IS NOT NULL` je v
    // Postgrese true, takže samotné `currency IS NOT NULL` by prázdnu menu prepustilo.
    check(
      "variant_money_needs_currency_ck",
      sql`(${t.currency} IS NOT NULL AND ${t.currency} != '') OR (${t.price} IS NULL AND ${t.standardPrice} IS NULL AND ${t.purchasePrice} IS NULL AND ${t.actionPrice} IS NULL)`,
    ),
  ],
);

export const ingestIssues = pgTable(
  "ingest_issue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => catalogSnapshots.id, { onDelete: "cascade" }),
    kind: ingestIssueKind("kind").notNull(),
    code: text("code").notNull(),
    detail: jsonb("detail").$type<Record<string, string>>(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [index("ingest_issue_snapshot_idx").on(t.snapshotId)],
);
