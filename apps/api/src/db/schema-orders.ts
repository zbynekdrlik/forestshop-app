import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  numeric,
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
  // issue 476: piaty EXKLUZÍVNY stav „Riešiť" (Štěpán, Discord 23.8.2026) —
  // presne princíp `nedostupne` (jeden radio klaster, svieti len jeden),
  // označený riadok sa zobrazí v sekcii Riešiť. Pridaný na KONIEC enumu
  // inkrementálnou migráciou `ALTER TYPE ... ADD VALUE 'riesit'` — hodnota sa
  // v žiadnej DDL nepoužíva (len runtime kód), takže sa NA ňu nevzťahuje past
  // issue 399 (55P04), viď `.claude/rules/database.md`.
  "riesit",
]);

// Odvodené priamo z `enumValues`, nie ručne prepísaná duplicitná únia — nová
// hodnota pridaná do `orderLineState` vyššie sa tak prejaví aj tu bez rizika
// rozídenia (#23, `modules/orders/queries.ts` + `http/orders-routes.ts`).
export type OrderLineState = (typeof orderLineState.enumValues)[number];

// Identita objednávky je Shoptet-ovo číslo objednávky (`externalOrderId`) —
// budúci importer (#21) ho potrebuje na idempotentné párovanie, rovnaký vzor
// ako `catalog_snapshot.content_sha256` unique.
//
// AKTUALIZÁCIA (issue 237, 2026-08-04): pôvodný komentár tu znel "Cena/mena
// na riadku sa ZÁMERNE nepridáva teraz" — to rozhodnutie je TERAZ prekonané,
// viď `totalPriceWithVat` nižšie. Dôvod zmeny: dashboard "Na objednanie"
// potrebuje tržbu zodpovedajúcu Shoptet dashboardu, ktorá sa bez uloženej
// sumy vôbec nedá dopočítať.
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
    // issue 164: SUROVÁ hodnota Shoptet-ovho "Poznámka e-shopu" poľa (export's
    // `shopRemark` stĺpec — INTERNÁ poznámka predajne, koncepčne DUPLIKUJE
    // appkine `comment` vyššie, ale je to Shoptetovo pole, `.claude/rules/
    // orders.md`). Ukladá sa surová (môže niesť aj náš vlastný zapísaný blok,
    // issue 123's `mergeShopRemark`) — rozdelenie na "naše"/"cudzie" sa robí
    // AŽ na čítacej strane (`modules/orders/queries.ts` cez `shoptet-
    // writeback/note-block.ts`'s `extractForeignShopRemark`), nikdy tu. VŽDY
    // Shoptetovo pole (rovnaká rodina ako `statusName`/`remark` vyššie,
    // NIKDY appkou/manažérom vlastnené) — `ingest.ts` ho pri re-importe
    // OSVIEŽI, presne ako `remark`.
    shopRemark: text("shop_remark"),
    // issue 120: Shoptet-ovo INTERNÉ (nie zákazníkovi viditeľné) číselné id
    // objednávky — JEDINÉ, ktoré Shoptet admin's `/admin/objednavky-detail/
    // ?id=<toto>` prijme (`?code=`/`?string=` na tejto trase ticho ignoruje,
    // funguje len `/admin/vyhladavanie/?string=`, `.claude/rules/orders.md`).
    // CSV export (`SHOPTET_ORDERS_URL`) toto pole VÔBEC nenesie — jediný
    // zdroj je samostatný XML export (`SHOPTET_ORDERS_XML_URL`, nepovinný
    // ako ostatné `SHOPTET_*` premenné), ktorý `ingest.ts` sťahuje NAVYŠE k
    // CSV, cez to isté `dateFrom`/`dateUntil` okno. Nullable a refreshované
    // LEN cez `COALESCE(excluded, staré)` (`ingest.ts`) — keď XML fetch
    // zlyhá alebo premenná nie je nastavená, predošlá zistená hodnota
    // PREŽIJE, nikdy sa nevynuluje na `null`.
    shoptetOrderId: integer("shoptet_order_id"),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // issue 123: KEDY bol `comment` (vyššie) naposledy ZMENENÝ manažérom —
    // nastavuje VÝLUČNE `setOrderComment` (`modules/orders/state.ts`), pri
    // KAŽDEJ zmene poľa vrátane vymazania na `null`. `null` = comment sa
    // ešte nikdy nezmenil cez appku (nový import, žiadny manažérov zásah).
    // Rovnaký pár ako `productSupplierLinkOverrides.updatedAt` z #122, len
    // na úrovni objednávky (namiesto samostatnej `updatedAt` na celej
    // `order`, ktorá by musela riešiť aj polia, čo appku vôbec nezaujímajú).
    commentUpdatedAt: timestamp("comment_updated_at", { withTimezone: true }),
    // issue 123: kedy bol `comment` naposledy ÚSPEŠNE zapísaný do Shoptetu
    // (potvrdené čerstvou navigáciou na detail objednávky po uložení, nikdy
    // len "odoslalo sa"). `null` = ešte nikdy. "Zmenené od posledného
    // zápisu" = `commentSyncedAt IS NULL OR commentSyncedAt <
    // commentUpdatedAt` (`order-note-select.ts`) — rovnaký vzor ako #122's
    // `product_supplier_link_override.synced_at`, len značené PER
    // OBJEDNÁVKA hneď po jej vlastnom úspechu (nie dávkovo na konci celého
    // behu), lebo tento zápis je per-objednávka, nie jeden hromadný CSV
    // import.
    commentSyncedAt: timestamp("comment_synced_at", { withTimezone: true }),
    // issue 172: štyri nové Shoptet-ove polia pre automatizáciu "Nevyzdvihnuté
    // zásielky" — rovnaká rodina ako `statusName`/`remark`/`shopRemark` vyššie
    // (VŽDY Shoptetovo pole, `ingest.ts` ho pri re-importe OSVIEŽI), ale na
    // rozdiel od nich sa extrahujú NEZÁVISLE od `mapOrderRow`'s
    // item-validácie (`parser.ts`'s `extractOrderLevelExtra`) — `email`/
    // `phone`/`packageNumber` sú na KAŽDOM riadku objednávky vrátane pseudo-
    // položiek (doprava/platba/zľava), a `shippingCarrierName` je práve na
    // SHIPPING pseudo-riadku, ktorý `mapOrderRow` inak celý zahodí
    // (`.claude/rules/orders.md`'s "itemCode nie je vždy skutočný produkt").
    // Nullable — nepovinné stĺpce exportu, chýbajúca hodnota sa mapuje na
    // `null`, nikdy na prázdny reťazec (rovnaký vzor ako `remark`).
    email: text("email"),
    phone: text("phone"),
    packageNumber: text("package_number"),
    shippingCarrierName: text("shipping_carrier_name"),
    // issue 237: celková suma objednávky S DPH (export's `totalPriceWithVat`
    // stĺpec) — order-level pole, opakované na KAŽDOM riadku exportu tej istej
    // objednávky (rovnaká rodina ako `customerName`/`statusName` vyššie,
    // `ingest.ts`'s `orderInfo` mapa berie prvý výskyt). VŽDY Shoptetovo pole
    // (rovnaký zámer ako `statusName`/`remark`/`shopRemark` — nikdy appkou/
    // manažérom vlastnené), re-import ho preto vždy OSVIEŽÍ. Nullable —
    // Shoptet ho gramaticky nijako neviaže a appka radšej zahodí nečitateľnú
    // hodnotu (`parseDecimalComma` z `catalog/money.ts`, zdieľaný Shoptet-
    // čiarkový money parser), než by transakcia spadla na jednom zlom riadku.
    // Používa sa VÝHRADNE na dashboardovú tržbu (`orders/overview.ts`) —
    // appka doteraz žiadnu peňažnú sumu neukladala vôbec.
    totalPriceWithVat: numeric("total_price_with_vat", { precision: 12, scale: 2 }),
    // issue 290: appkina VLASTNÁ reklamácia-značka — Shoptet nemá pre
    // reklamácie žiadny použiteľný stav ani políčko v produkčných dátach
    // (jeho číselníkový stav "REKLAMACIA" nikdy nedostane priradenú žiadnu
    // objednávku, overené naživo proti produkcii), takže appka si ju musí
    // viesť sama. `null` = neoznačená (bežná objednávka). Vyplnené =
    // obsluha ju ručne označila cez "Eshop → Reklamácie" — jediný zápis
    // do tohto poľa, `modules/orders/order-flags.ts`'s `markOrderClaim`/
    // `clearOrderClaim`. NIKDY sa neodvodzuje z `statusName`/`comment`/AI
    // dohadu (rozhodnuté na tickete — žiadne AI dohady o reklamácii).
    claimMarkedAt: timestamp("claim_marked_at", { withTimezone: true }),
    // Nepovinná krátka poznámka obsluhy k reklamácii (napr. "chybný zips,
    // čaká sa na vrátenie") — vypĺňa sa/maže spolu s `claimMarkedAt` vyššie,
    // nikdy samostatne.
    claimNote: text("claim_note"),
    // issue 292: doručovacia adresa + hmotnosť + spôsob platby — appka ich
    // predtým vôbec neukladala (potreba DPD prepravy). Rovnaká rodina ako
    // `email`/`phone`/`packageNumber`/`shippingCarrierName` (issue 172) —
    // VŽDY Shoptetovo pole, `ingest.ts` ho pri re-importe OSVIEŽÍ, nikdy
    // appkou/manažérom vlastnené. Nullable, chýbajúca hodnota = `null`.
    deliveryFullName: text("delivery_full_name"),
    deliveryCompany: text("delivery_company"),
    deliveryStreet: text("delivery_street"),
    deliveryHouseNumber: text("delivery_house_number"),
    deliveryCity: text("delivery_city"),
    deliveryZip: text("delivery_zip"),
    deliveryCountryName: text("delivery_country_name"),
    // issue 292: export's `weight` stĺpec (kg), Shoptet-ova desatinná
    // čiarka — parsuje sa rovnakým `parseDecimalComma` ako `totalPriceWithVat`
    // vyššie (preto rovnaká `scale: 2` presnosť — `parseDecimalComma` sama
    // zaokrúhľuje na 2 desatinné miesta, `money.ts`'s `roundToTwoDecimals`).
    // Väčšina reálnych objednávok má `0` (obchod hmotnosť dôsledne
    // nezapisuje) — appka preto pri DPD náhľade dopĺňa rozumný predvolený
    // odhad, keď je `0`/`null` (`modules/dpd/preview.ts`), toto pole nesie
    // SUROVÚ (možno nulovú) hodnotu z exportu, nikdy dopočítaný odhad.
    weight: numeric("weight", { precision: 10, scale: 2 }),
    // issue 292: spôsob platby — Shoptet ho NEMÁ ako samostatný stĺpec
    // objednávky, ale ako `itemName` na `BILLING*` pseudo-riadku (rovnaký
    // trik ako `shippingCarrierName` z `SHIPPING*` pseudo-riadku vyššie).
    // Naživo overené (7.8.2026, 90-dňový export): "Dobierka (hotovosť) +
    // karta (len SR)" a "V hotovosti" — appka rozpozná dobierku podľa toho,
    // či reťazec obsahuje "dobierka" (bez ohľadu na veľkosť písmen).
    paymentMethodName: text("payment_method_name"),
    // issue 292: export's `priceToPay` stĺpec — suma, ktorú má zákazník
    // ešte zaplatiť (dobierková suma, keď `paymentMethodName` je dobierka).
    // Rovnaký `parseDecimalComma` parser ako `totalPriceWithVat`/`weight`.
    priceToPay: numeric("price_to_pay", { precision: 12, scale: 2 }),
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

// issue 121: majiteľ, doslovne "ak na produkt nie je odkaz na dodavatela, tak
// tam ma byt moznost ho doplnit, a vlastne pri kazdom produkte ma byt moznost
// upravit link na dodavatela". Priamy náprotivok `productSupplierOverrides`
// vyššie (rovnaké kľúčovanie `product.key`, nie variantom — `internalNote`,
// z ktorého sa odkaz extrahuje, je vlastnosť CELÉHO produktu naprieč
// veľkosťami, `.claude/rules/catalog.md`), ale s JEDNÝM podstatným rozdielom:
// `productSupplierOverrides` je FALLBACK povolený LEN keď katalóg pole nemá
// (`supplierAssignable`/409 "already_has_supplier" gate) — tu majiteľ výslovne
// žiada úpravu "pri KAŽDOM produkte", teda AJ keď Shoptet odkaz už poskytuje.
// Čítacia strana preto VŽDY uprednostní TENTO riadok pred extrahovaným
// `internalNote` odkazom (`coalesce(override.url, extractSupplierLink(...).url)`,
// `queries.ts`), nikdy podmienene ako override vyššie. Zápis (`internalNote`
// samotný) nikdy nemení — nočný katalógový import by ho pri ďalšom behu
// prepísal (dôvod, prečo appka doteraz nemala VÔBEC žiadnu zápisovú cestu na
// tento odkaz). `ON DELETE CASCADE` — rovnaký zámer ako `productSupplierOverrides`
// (produkt sa reálne nikdy nemaže, ale osamotený riadok bez zmyslu nemá dôvod
// prežiť). Nasledujúci samostatný ticket (#122) spätne zapisuje TENTO odkaz do
// Shoptetu cez hromadný CSV import — táto tabuľka je jeho zdroj pravdy.
export const productSupplierLinkOverrides = pgTable("product_supplier_link_override", {
  productKey: text("product_key")
    .primaryKey()
    .references(() => products.key, { onDelete: "cascade" }),
  url: text("url").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // issue 122: KEDY bol tento riadok naposledy ÚSPEŠNE zapísaný späť do
  // Shoptetu (potvrdené z Logu — nikdy len "odoslané"). `null` = ešte nikdy.
  // "Zmenené od posledného zápisu" = `syncedAt IS NULL OR syncedAt <
  // updatedAt` (select-changes.ts) — to je zdroj pravdy pre to, KTORÉ
  // produkty CSV write-back nesie, nikdy celý katalóg. Zámerne SAMOSTATNÝ
  // stĺpec, nie prepočítavaný z `job_run` — viaže sa na KONKRÉTNY riadok
  // override, nie na "posledný beh úlohy vôbec" (ten mohol zlyhať len na
  // INOM produkte).
  syncedAt: timestamp("synced_at", { withTimezone: true }),
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
