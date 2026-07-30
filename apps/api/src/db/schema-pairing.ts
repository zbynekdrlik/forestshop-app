import { sql } from "drizzle-orm";
import { check, index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { variants } from "./schema-catalog.js";
import { users } from "./schema-users.js";

// Dodávateľ vo veľkoobchodnom zmysle (adaptér na vyhľadávanie/potvrdzovanie
// kandidátov, mena, veľkoobchodná stránka) — NIE to isté ako `product.supplier`
// (voľný textový reťazec zo Shoptet exportu) ani `supplier_contact` (#31, mailový
// kontakt). Kľúčovaný PRIAMO menom (rovnaký vzor ako `supplier_contact.supplier`),
// zámerne BEZ syntetického `id` — meno dodávateľa je už dnes jediná identita, akú
// appka pozná (`product.supplier`, `supplier_contact.supplier`), a zavádzať popri
// nej druhú, konkurenčnú identitu (uuid) by rozdvojilo ten istý reálny subjekt bez
// toho, aby to táto úloha potrebovala (návrhový komentár na #44 — zamietnutá
// alternatíva). Join z `pairing` na tento riadok ide cez
// `variant.product_key → product.supplier` (text) ↔ `supplier.name`, nie cez FK.
export const suppliers = pgTable("supplier", {
  name: text("name").primaryKey(),
  // Bez meny sa suma nedá zapísať (rovnaká filozofia ako
  // `variant_money_needs_currency_ck` v schema-catalog.ts) — veľkoobchodné ceny
  // dodávateľa majú vždy zmysel len s menou.
  currency: text("currency").notNull(),
  // Nullable — dodávateľ bez automatizovaného adaptéra (len ručné párovanie)
  // nemusí mať základnú URL vôbec.
  wholesaleBaseUrl: text("wholesale_base_url"),
  // Nullable — null znamená "žiadny automatizovaný adaptér, len ručné párovanie"
  // (#46/#48 sú budúce úlohy, ktoré adaptérový kľúč skutočne použijú).
  adapterKey: text("adapter_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Stav páru (variant ↔ adresa u dodávateľa) ako automat, rovnaký vzor bez
// diakritiky ako `order_line_state`/`user_role`: navrhnuté (kandidát/ručne
// zadaná adresa, ešte nepotvrdené) → potvrdené (manažér potvrdil zhodu).
export const pairingState = pgEnum("pairing_state", ["navrhnute", "potvrdene"]);

// Jeden riadok na KAŽDÝ variant (veľkosť) — nikdy na produkt ako celok. Práve
// toto UNIQUE na `variantCode` je štrukturálna oprava chyby starej appky (#44
// návrhový komentár): tam bolo rozhodnutie o párovaní uložené per-produkt
// (JSON), takže dve veľkosti jedného produktu sa nikdy nepotvrdili naraz
// (#273/#304 v starom repe). Tu má KAŽDÁ veľkosť svoj vlastný riadok a vlastný
// stav — javovo to už nemôže nastať.
export const pairings = pgTable(
  "pairing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // FK na `variant.code` (identita variantu, viď schema-catalog.ts). Bez
    // `onDelete` — varianty sa nikdy nemažú (len `missingSince`), rovnaký vzor
    // ako `order_line.variant_code`. `.unique()` je zámerne PRIAMO tu (nie
    // samostatný index nižšie) — mirror `orders.externalOrderId`.
    variantCode: text("variant_code")
      .notNull()
      .unique()
      .references(() => variants.code),
    // Adresa produktu u dodávateľa — buď automaticky nájdený kandidát (#46),
    // alebo manažérom ručne zadaná (#45). Nullable: riadok môže existovať aj
    // predtým, než sa nájde/zadá konkrétna adresa.
    supplierUrl: text("supplier_url"),
    state: pairingState("state").notNull().default("navrhnute"),
    // Kto a kedy potvrdil zhodu (#45) — vyplnené PRÁVE VTEDY, keď je
    // state='potvrdene' (viď CHECK nižšie). `onDelete: "restrict"` (NIE
    // "set null", pôvodná voľba pri #44 — mirror `audit_events.actor_user_id` —
    // ktorá tu nikdy nemohla reálne nastať): `pairing_confirmation_ck`
    // vyžaduje `confirmed_by` vyplnené vždy, keď state='potvrdene', takže
    // set-null by vždy porušil CHECK skôr, než by k nemu vôbec došlo, a
    // Postgres by delete zamietol so zavádzajúcou CHECK-violation namiesto
    // jasnej FK-violation. "restrict" mení len TOTO — deklarovaný zámer teraz
    // zodpovedá skutočnému, nezmenenému správaniu: používateľa, ktorý potvrdil
    // pairing, nemožno zmazať, história potvrdenia (KTO a KEDY) ostáva
    // nedotknutá (review nález na PR #50, issue 44).
    confirmedBy: uuid("confirmed_by").references(() => users.id, { onDelete: "restrict" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pairing_state_idx").on(t.state),
    // FK stĺpec bez indexu → seq-scan cez `pairing` pri KAŽDOM zmazaní/update
    // `users.id` (review nález na PR #50, issue 44).
    index("pairing_confirmed_by_idx").on(t.confirmedBy),
    // Automat vynútený databázou, nie len kódom (rovnaký vzor ako
    // `catalog_snapshot_reason_ck`, ale rozšírený na DVA stĺpce naraz):
    // `confirmed_by`/`confirmed_at` sú buď OBA null (state navrhnute), alebo
    // OBA vyplnené (state potvrdene) — nikdy napoly potvrdený riadok.
    // POZOR: jednoduché `(state = 'potvrdene') = (confirmed_by IS NOT NULL AND
    // confirmed_at IS NOT NULL)` (vzor jedného stĺpca z catalog_snapshot) TU
    // NESTAČÍ — pri state≠potvrdene stačí, aby čo i len JEDEN z dvoch stĺpcov
    // bol null, aby pravá strana bola false, takže "navrhnute" s vyplneným
    // len confirmed_by (confirmed_at null) by prešlo (overené naživo proti
    // Postgresu, code review na PR #50). Explicitný dvojsmerný OR nižšie
    // vyžaduje OBA stĺpce zhodne — žiadna polovičná kombinácia neprejde.
    check(
      "pairing_confirmation_ck",
      sql`(${t.state} = 'potvrdene' AND ${t.confirmedBy} IS NOT NULL AND ${t.confirmedAt} IS NOT NULL)
        OR (${t.state} != 'potvrdene' AND ${t.confirmedBy} IS NULL AND ${t.confirmedAt} IS NULL)`,
    ),
  ],
);
