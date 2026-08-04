import {
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// Dostupnosť tovaru U DODÁVATEĽA — zámerne INÝ číselník než `variantState`
// (`schema-catalog.ts`). Ten popisuje NÁŠ eshop (predajný / vypredaný / už sa
// nepredáva); tento odpovedá na jedinú otázku „vieme to od dodávateľa
// objednať?". `unknown` je plnohodnotná hodnota, nie chýbajúci údaj: stránka
// sa načítala, ale dostupnosť sa z nej NEDALA určiť. Automatizácia
// (issue 213) prepína VÝHRADNE na `available` — `unknown` nikdy, aby sa
// nikdy nezapisovalo na základe dohadu.
export const supplierAvailability = pgEnum("supplier_availability", [
  "available",
  "unavailable",
  "unknown",
]);

// Čím sa dostupnosť podarilo prečítať — diagnostika pre kartu „Stránky, ktoré
// neviem prečítať" (majiteľ chce vidieť, pre ktorého dodávateľa sa oplatí
// dorobiť čítanie). `none` = neprešla ani jedna úroveň.
export const supplierStockSource = pgEnum("supplier_stock_source", [
  "json_ld",
  "meta",
  "text",
  "size_list",
  "none",
]);

// Jeden riadok na dvojicu (UNIKÁTNA dodávateľská linka, NAŠA veľkosť) —
// issue 224. Pôvodne bol riadok len na linku (jedna dostupnosť pre celý
// odkaz), čo bolo nesprávne pre 965 z 2 179 liniek, ktoré pokrývajú VIAC
// našich variantov (rôzne veľkosti) naraz: dostupnosť náhodne prečítanej
// veľkosti sa aplikovala na všetky ostatné. `size_label = ''` znamená
// "dostupnosť CELÉHO odkazu" — jednoveľkostný produkt, ALEBO doména bez
// vlastného pravidla na čítanie zoznamu veľkostí (`SIZE_AVAILABILITY_RULES`,
// `parse.ts`) — a je to jediný riadok, aký sa pre taký odkaz zapíše. Odkaz S
// pravidlom dostáva PRESNE jeden riadok na KAŽDÚ našu veľkosť, ktorá sa naň
// viaže (`run.ts`), nikdy oba tvary naraz pre ten istý odkaz.
export const supplierStock = pgTable(
  "supplier_stock",
  {
    link: text("link").notNull(),
    sizeLabel: text("size_label").notNull().default(""),
    // Doména bez `www.` — nesie sa uložená (nie počítaná pri čítaní), aby sa
    // dala indexovať a zoskupovať v prehľade nečitateľných stránok.
    host: text("host").notNull(),
    availability: supplierAvailability("availability").notNull(),
    // Pôvodný text zo stránky, NEZMENENÝ — rovnaká filozofia ako
    // `variant.availability_text` v katalógu: hodnota sa ukladá tak, ako
    // prišla, a stav sa z nej len odvodzuje.
    availabilityText: text("availability_text").notNull().default(""),
    price: numeric("price", { precision: 12, scale: 2 }),
    source: supplierStockSource("source").notNull(),
    // `false` = kontrola sama zlyhala (sieť, časový limit, HTTP chyba).
    // Odlišné od `availability = 'unknown'`, kde sa stránka NAČÍTALA, len sa
    // z nej nedalo nič vyčítať — obe sú dôvod NEPREPNÚŤ, ale operátorovi
    // hovoria niečo úplne iné.
    ok: boolean("ok").notNull(),
    error: text("error"),
    httpStatus: integer("http_status"),
    // Čas POSLEDNÉHO POKUSU (aj neúspešného) — riadi preskakovanie čerstvých
    // liniek, aby zlyhávajúca stránka nezacyklila každý beh na tom istom
    // časovom limite.
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    // Čas posledného ÚSPEŠNÉHO určenia dostupnosti. Automatizácia (issue 213)
    // meria čerstvosť potvrdenia PODĽA TOHTO poľa, nikdy podľa `checkedAt` —
    // inak by opakovane zlyhávajúca kontrola donekonečna predlžovala platnosť
    // dávno neaktuálneho „skladom".
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.link, t.sizeLabel] }),
    index("supplier_stock_host_idx").on(t.host),
    index("supplier_stock_avail_idx").on(t.availability),
  ],
);
