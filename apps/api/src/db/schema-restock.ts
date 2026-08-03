import { boolean, index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// issue 213: "Vypredané → Skladom". Jediná automatizácia v appke, ktorá
// ZAPISUJE do e-shopu bez toho, aby na to niekto klikol — preto má vlastný
// Štart/Stop prepínač (rovnaký singleton vzor ako `posta_uncollected_settings`).
export const restockSettings = pgTable("restock_settings", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

// Jeden riadok na KAŽDÉ prepnutie — to je odpoveď na majiteľovo "bude to tam
// vydno ze to funguje a ze to prepina produkty". Riadky sa nikdy nemažú ani
// neprepisujú: je to história, nie stav.
export const restockEvents = pgTable(
  "restock_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    variantCode: text("variant_code").notNull(),
    pairCode: text("pair_code"),
    productName: text("product_name").notNull(),
    supplier: text("supplier"),
    // Odkaz, na základe ktorého sa rozhodlo — spolu s textom, ktorý dodávateľ
    // hlásil, tvorí celý dôkaz „prečo sa toto preplo".
    supplierLink: text("supplier_link").notNull(),
    supplierAvailabilityText: text("supplier_availability_text").notNull().default(""),
    supplierPrice: numeric("supplier_price", { precision: 12, scale: 2 }),
    // Kedy dodávateľa naposledy potvrdila kontrola (`supplier_stock.confirmed_at`)
    // — bez toho by sa spätne nedalo overiť, či potvrdenie bolo čerstvé.
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("restock_event_at_idx").on(t.at), index("restock_event_variant_idx").on(t.variantCode)],
);
