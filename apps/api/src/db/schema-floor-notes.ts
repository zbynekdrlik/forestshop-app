import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { variants } from "./schema-catalog.js";
import { users } from "./schema-users.js";

// issue 410: "Eshop → Objednávky predajňa" — nahrádza Štěpánovo Discord vlákno
// (voľný text + 🛒/✅/🔥 reakcie ako značky) pre zápisy vytvorené priamo na
// predajni ("príde niekto na predajňu a chce niečo"). Nahrádza pôvodnú
// Shoptet-viazanú obrazovku (`shipping_carrier_name ILIKE '%Osobný odber%'`,
// issue 345) — tá väzba sa RUŠÍ (design komentár na ticket-e).
//
// Zámerne SAMOSTATNÁ od `upozornenie` (`.claude/rules/upozornenia.md`) —
// tá nesie postpone/resolve/dedupKey/seenAt/odznak sémantiku pre zdieľanú
// FIRIEMNU frontu upozornení, nič z toho tento zoznam nepotrebuje (rovnaké
// odôvodnenie, aké má `daily_task`, issue 342). Na rozdiel od `daily_task`
// (súkromný, per-`user_id`) je toto ZDIEĽANÝ tabuľový zoznam — ktorýkoľvek
// prihlásený zamestnanec vidí VŠETKY zápisy, žiadny `user_id` filter na
// čítaní (design komentár na ticket-e).
export const floorNotes = pgTable(
  "floor_note",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Voľný text (adresa, kontakt, čokoľvek) — appka nevynucuje žiadnu
    // štruktúru, presne ako Štěpánovo Discord vlákno. `.default("")` je len
    // záchranná sieť (rovnaký vzor ako `upozornenie.details`), appka VŽDY
    // pošle neprázdny text pri vytvorení (`createBody`'s `.min(1)`).
    text: text("text").notNull().default(""),
    // Tri NEZÁVISLÉ značky-prepínače BEZ ďalšej funkcie (len označenie, ako
    // Discord reakcie ✅/🛒/📞 — ticket to hovorí explicitne). Obyčajný
    // boolean, žiadny timestamp — appka nikdy nepotrebuje "kedy" bola
    // značka nastavená, len jej aktuálny stav.
    resolved: boolean("resolved").notNull().default(false),
    ordered: boolean("ordered").notNull().default(false),
    called: boolean("called").notNull().default(false),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Zoznam sa vždy číta "najnovšie hore" (`.claude/rules/database.md` —
    // index podľa toho, ako sa dáta SKUTOČNE čítajú), s `id` tie-breakerom
    // rovnakým vzorom ako `floor-orders-queries.ts`/`catalog/queries.ts`.
    index("floor_note_created_at_idx").on(t.createdAt),
  ],
);

// Pripnuté produkty na zázname — 0..N, klikateľné, otvárajú DETAIL na
// www.forestshop.sk. Kľúčované `variant.code` (NIE `product.key`, na
// rozdiel od `product_supplier_link_override`) — design komentár na
// ticket-e: vyhľadávacie výsledky ("Vyhľadať") sú per-VARIANT (jeden
// riadok na SKU/veľkosť) a `shop_product_url` je TIEŽ kľúčovaná
// variantovým kódom, takže pripnutie na úrovni variantu drží presnú
// veľkosť, ktorú si zákazník pýtal, a priama linka je jednostĺpcový JOIN.
export const floorNoteProducts = pgTable(
  "floor_note_product",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    floorNoteId: uuid("floor_note_id")
      .notNull()
      .references(() => floorNotes.id, { onDelete: "cascade" }),
    // Bez `onDelete` (rovnaký vzor ako `order_line.variant_code` —
    // `.claude/rules/database.md`) — varianty sa v tejto appke NIKDY
    // nemažú (katalógový import ich len aktualizuje/označí discontinued),
    // takže "restrict" v praxi nikdy nenastane, len presne popisuje
    // realitu.
    variantCode: text("variant_code")
      .notNull()
      .references(() => variants.code),
    // issue 453: počet kusov TOHTO variantu na TOMTO zázname (šéf: "neviem
    // dať počet kusov"). Atribút VZŤAHU, preto stĺpec junction riadku, nie
    // samostatná tabuľka. `.default(1)` backfilne existujúce riadky
    // (šéfov prvý zápis) na 1 pri `ADD COLUMN` — žiadny enum, žiadne
    // riziko 55P04 (`.claude/rules/database.md`). CHECK `>= 1` nižšie je
    // druhá obrana popri zod `int().min(1)` na trase.
    quantity: integer("quantity").notNull().default(1),
    // issue 480: kedy sa TÁTO položka zápisu objednala u dodávateľa v board-e
    // „Na objednanie" (nullable, `NULL` = ešte neobjednané). Priamy náprotivok
    // `order_line.ordered` (issue 60), len ako časová pečiatka namiesto boolean
    // — timestamp nesie aj „kedy" a je konzistentný s audit-ovanými zápismi.
    // `floor_note.ordered` (🛒) sa z neho PREPOČÍTA (`floor-notes/service.ts`'s
    // `recomputeFloorNoteOrdered`): true práve keď má zápis ≥1 položku a VŠETKY
    // majú `ordered_at`. Predajňové riadky do „Na objednanie" pridáva
    // `orders/queries.ts` (rovnaká efektívna dodávateľská cesta ako order_line).
    orderedAt: timestamp("ordered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("floor_note_product_note_idx").on(t.floorNoteId),
    // Ten istý produkt sa na TEN ISTÝ záznam nedá pripnúť dvakrát — appka
    // to rieši `onConflictDoNothing` (idempotentné "Pripnúť"), nie chybou.
    uniqueIndex("floor_note_product_note_variant_uq").on(t.floorNoteId, t.variantCode),
    // Rovnaký vzor ako `order_line_quantity_positive_ck` — počet kusov je
    // vždy aspoň 1.
    check("floor_note_product_quantity_ck", sql`${t.quantity} >= 1`),
  ],
);
