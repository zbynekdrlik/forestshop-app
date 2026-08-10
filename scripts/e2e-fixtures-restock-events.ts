// issue 329: história "Prepnuté produkty" na "Vypredané → Skladom" teraz nesie
// aj odkaz na náš produkt z feedu pre porovnávače — vyčlenené z `e2e-setup.ts`
// (eslint `max-lines: 400`, `.claude/rules/testing.md`), rovnaký vzor ako
// existujúci `e2e-fixtures-restock-links.ts`. `restock_event` je plochá
// história bez FK na `variant`/`product` (`schema-restock.ts`), takže tu
// netreba seedovať ani jedno z nich — len samotné udalosti (a pre jednu z nich
// zodpovedajúci `shop_product_url` riadok).
import type { Database } from "../apps/api/src/db/client.js";
import { restockEvents, shopProductUrl } from "../apps/api/src/db/schema.js";

export async function seedRestockEventsFixtures(db: Database, teraz: Date): Promise<void> {
  await db.insert(restockEvents).values({
    at: teraz,
    variantCode: "PREP-EVT-1",
    productName: "E2E Bunda Prepnutá S Odkazom",
    supplier: "DODAVATEL-PREPINANIE",
    supplierLink: "https://huntingshop.eu/e2e-prepnuta-1",
    supplierAvailabilityText: "skladom",
    supplierPrice: "44.90",
    confirmedAt: teraz,
  });
  await db.insert(shopProductUrl).values({
    code: "PREP-EVT-1",
    url: "https://www.forestshop.sk/e2e-prepnuta-1/",
    fetchedAt: teraz,
  });

  // issue 329: kód, ktorý vo feede pre porovnávače nie je — dôkaz, že riadok
  // histórie sa vykreslí bez odkazu (a bez chyby), nikdy s náhradným/mŕtvym
  // odkazom.
  await db.insert(restockEvents).values({
    at: teraz,
    variantCode: "PREP-EVT-2",
    productName: "E2E Bunda Prepnutá Bez Odkazu",
    supplier: "DODAVATEL-PREPINANIE",
    supplierLink: "https://huntingshop.eu/e2e-prepnuta-2",
    supplierAvailabilityText: "skladom",
    supplierPrice: "34.90",
    confirmedAt: teraz,
  });
}
