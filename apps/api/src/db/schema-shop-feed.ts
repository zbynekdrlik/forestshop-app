import { pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// issue 402: odkiaľ POCHÁDZA riadok — `feed` (google.xml, `shop-feed/
// run.ts`) je AUTORITATÍVNY zdroj a smie prepísať čokoľvek; `sitemap`/
// `probe` (`shop-sitemap/run.ts`) zapisuje LEN kódy, ktoré `feed` nepokrýva,
// a NIKDY neprepíše riadok, čo už feed potvrdil. Bez tohto rozlíšenia by
// `shop-sitemap`'s beh nevedel, KTORÉ riadky smie obnoviť/nechať tak a
// KTORÉ patria feedu.
export const shopProductUrlSource = pgEnum("shop_product_url_source", ["feed", "sitemap", "probe"]);

// Mapa „kód variantu → adresa detailu na NAŠOM e-shope" (issue 220).
//
// Zdroj je Shoptetom generovaný feed pre porovnávače (`google.xml`). Tabuľka
// je zámerne PLOCHÁ a bez väzby na `variant`: feed a katalóg sa napĺňajú
// nezávisle a v rôznom čase, takže cudzí kľúč by pri každom nesúlade zhodil
// celý import kvôli veci, ktorá je len pomôcka na zobrazenie odkazu.
//
// Kľúč je `code` v tom istom tvare ako `variant.code` (vrátane veľkosti za
// lomítkom, napr. `40237/M`) — feed generuje jednu položku na variant, takže
// adresa vie obsahovať aj `?variantId=…` a otvorí rovno správnu veľkosť.
export const shopProductUrl = pgTable("shop_product_url", {
  code: text("code").primaryKey(),
  url: text("url").notNull(),
  // Shoptetova VLASTNÁ dostupnosť z feedu (issue 226) — surový text
  // `<g:availability>` ("in stock"/"out of stock"), `null` keď je značka
  // prázdna. Nezávislý zdroj pravdy na krížovú kontrolu nášho odvodeného
  // `variant.state` (`modules/catalog/feed-cross-check.ts`) — issue 219
  // ukázalo, že naša vlastná dedukcia sa vie rozísť s realitou.
  availability: text("availability"),
  // Čas behu, ktorý riadok naposledy potvrdil — keď feed na strane Shoptetu
  // zamrzne, na obrazovke je vidieť, že mapa starne.
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  // issue 347: obrázok produktu (`<g:image_link>`) — appka ho potrebuje na
  // vykreslenie produktovej karty v e-maile "alternatívy k nedostupnému
  // tovaru" (`nedostupne/resolve-products.ts`). Nullable rovnako ako
  // `availability` vyššie — nie každá položka feedu obrázok nesie.
  imageUrl: text("image_url"),
  // issue 402: additive stĺpec, existujúce riadky (všetky doteraz pochádzali
  // z feedu) dostanú default `'feed'` pri migrácii — `shop-feed/run.ts`'s
  // UPSERT ho odteraz zapisuje explicitne pri KAŽDOM behu (rovnaká
  // disciplína ako `availability`/`imageUrl` — feed VŽDY reklamuje kód
  // späť, ak ho odteraz pokrýva).
  source: shopProductUrlSource("source").notNull().default("feed"),
});
