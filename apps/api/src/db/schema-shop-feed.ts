import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
  // Čas behu, ktorý riadok naposledy potvrdil — keď feed na strane Shoptetu
  // zamrzne, na obrazovke je vidieť, že mapa starne.
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});
