import { sql, type SQL } from "drizzle-orm";
import { products, productSupplierOverrides } from "../../db/schema.js";

// issue 63: efektívny dodávateľ riadku — katalógová hodnota (`product.supplier`),
// a keď je `null`, manažérovo ručné priradenie (`product_supplier_override`).
// Použité na VŠETKÝCH čítacích cestách, ktoré dnes zoskupujú/filtrujú podľa
// dodávateľa (`queries.ts`'s `listOpenOrderLinesBySupplier` +
// `listOpenOrderLineIdsForSupplier`, `mail.ts`'s `loadOutstandingLines`,
// `getOrderDetail`) — inak by hromadná akcia/mail dodávateľovi nezasiahli
// riadky, ktoré normalizácia nižšie práve zlúčila do tej istej skupiny
// (rovnaká trieda chyby ako review of PR 75/76, `.claude/rules/orders.md`).
// Override je FALLBACK pre "zatiaľ bez dodávateľa", nikdy trvalý pin — keď
// Shoptet raz dodá reálnu hodnotu, tá (ľavá strana coalesce) vyhráva.
export const effectiveSupplierSql: SQL<string | null> = sql`coalesce(${products.supplier}, ${productSupplierOverrides.supplier})`;

// Case/whitespace-insensitive porovnávací kľúč — priamy náprotivok legacy
// appky's `supKey` (`webreview/static/app.js`). Použité na SQL strane
// (bulk akcia/mail filter), aby dva pravopisy toho istého dodávateľa boli
// TÁ ISTÁ skupina aj tam, nielen v hlavnom zoznamovom dopyte.
export function normalizedSupplierKeySql(expr: SQL<string | null>): SQL<string> {
  // POZOR: `\s` NIE JE platný JS escape v šablónovom literáli — JS ho ticho
  // premení na holé `s` (backslash zmizne), takže SQL text, ktorý reálne
  // odíde na Postgres, by niesol `'s+'` namiesto regexu na whitespace (presne
  // takto sa to naživo prejavilo — `regexp_replace` prestal zbierať
  // viacnásobné medzery, `pickCanonicalSupplierSpelling`/hromadná akcia
  // prestali zlučovať dodávateľov s vnútornými medzerami navyše). `\\s+`
  // (dvojitý backslash) je JEDINÝ spôsob, ako dostať doslovné `\s+` do SQL
  // textu odtiaľto.
  return sql`lower(regexp_replace(trim(both from ${expr}), '\\s+', ' ', 'g'))`;
}

// Rovnaká normalizácia, čistý JS — stavia zoskupovaciu Mapu v
// `listOpenOrderLinesBySupplier` a porovnáva prichádzajúci reťazec (parameter
// z URL/tela requestu) s SQL-vypočítaným kľúčom vyššie. Case sa NEFOLDUJE pri
// ZÁPISE (`assignOrderLineSupplier` ukladá presne to, čo manažér napísal, len
// s orezaným whitespace-om) — rovnaké rozhodnutie ako legacy `saveSupplier`.
export function normalizeSupplierKeyJs(supplier: string): string {
  return supplier.trim().replace(/\s+/g, " ").toLowerCase();
}

// issue 63: keď normalizácia zlúči viacero pravopisov do jednej skupiny,
// zobrazí sa NAJČASTEJŠÍ (podľa počtu riadkov objednávky, ktoré ho niesli;
// remíza → abecedne prvý, deterministicky). Čistá funkcia — jednotkovo
// testovateľná bez DB. Jednoduchšie než legacy's dvojúrovňové vážené
// hlasovanie (riadky vs. stĺpce dvoch nezávislých polí,
// `supplierSpellingIndex`) — táto appka má len JEDEN zdroj pravopisu na
// riadok (`effectiveSupplierSql`), nie dve nezávislé polia ako legacy's
// `supplier`/`assignedSupplier`.
export function pickCanonicalSupplierSpelling(spellingCounts: ReadonlyMap<string, number>): string {
  const entries = [...spellingCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let best: string | null = null;
  let bestCount = -1;
  for (const [spelling, count] of entries) {
    if (count > bestCount) {
      best = spelling;
      bestCount = count;
    }
  }
  if (best === null) throw new Error("pickCanonicalSupplierSpelling: prázdna množina pravopisov");
  return best;
}
