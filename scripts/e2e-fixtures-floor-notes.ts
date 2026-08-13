// issue 410: "Eshop → Objednávky predajňa" — vyčlenené do VLASTNÉHO súboru
// (rovnaký dôvod ako `e2e-fixtures-search.ts`, eslint `max-lines: 400`,
// `.claude/rules/testing.md`). VLASTNÝ izolovaný E2E účet (zdieľaný
// `e2e@forestshop.sk` je už na hranici `MAX_ATTEMPTS`) + DVA VLASTNÉ,
// dovtedy nepoužité produkty/varianty — jeden S priamou `shop_product_url`
// adresou (dôkaz priameho odkazu), jeden BEZ nej (dôkaz vizuálne
// odlíšeného náhradného odkazu, design komentár na ticket-e).
import type { Database } from "../apps/api/src/db/client.js";
import { products, shopProductUrl, users, variants } from "../apps/api/src/db/schema.js";
import { hashPassword } from "../apps/api/src/modules/auth/passwords.js";

// Musí sa zhodovať s hodnotou v `apps/web/tests/e2e/floor-notes.spec.ts` —
// znovu použitý e-mail z pôvodnej (issue 345) fixtúry, tá bola odstránená
// spolu s jej Shoptet-viazanou obrazovkou, takže žiadny nárast rate-limit
// rozpočtu.
export const E2E_PREDAJNA_EMAIL = "e2e-predajna@forestshop.sk";

const PRODUCT_KEY_S_ODKAZOM = "E2E-PREDAJNA-1";
const VARIANT_S_ODKAZOM = "E2E-PREDAJNA-1";
const PRODUCT_KEY_BEZ_ODKAZU = "E2E-PREDAJNA-2";
const VARIANT_BEZ_ODKAZU = "E2E-PREDAJNA-2";

export async function seedFloorNotesFixtures(db: Database, teraz: Date, snapshotId: string, heslo: string): Promise<void> {
  await db.insert(users).values({
    email: E2E_PREDAJNA_EMAIL,
    passwordHash: await hashPassword(heslo),
    displayName: "E2E Manažér Predajňa",
    role: "manazer",
  });

  await db.insert(products).values([
    {
      key: PRODUCT_KEY_S_ODKAZOM,
      name: "E2E Predajňa Bunda Rogaland",
      firstSeenAt: teraz,
      lastSeenAt: teraz,
      lastSeenSnapshotId: snapshotId,
    },
    {
      key: PRODUCT_KEY_BEZ_ODKAZU,
      name: "E2E Predajňa Čiapka Polar",
      firstSeenAt: teraz,
      lastSeenAt: teraz,
      lastSeenSnapshotId: snapshotId,
    },
  ]);

  await db.insert(variants).values([
    {
      code: VARIANT_S_ODKAZOM,
      productKey: PRODUCT_KEY_S_ODKAZOM,
      guid: PRODUCT_KEY_S_ODKAZOM,
      name: "E2E Predajňa Bunda Rogaland",
      sizeLabel: "L",
      currency: "EUR",
      price: "89.90",
      stock: 5,
      availabilityInStockText: "Skladom",
      availabilityOutOfStockText: "Vypredané",
      availabilityText: "Skladom",
      productVisibility: "visible",
      state: "sellable",
      firstSeenAt: teraz,
      lastSeenAt: teraz,
      lastSeenSnapshotId: snapshotId,
    },
    {
      code: VARIANT_BEZ_ODKAZU,
      productKey: PRODUCT_KEY_BEZ_ODKAZU,
      guid: PRODUCT_KEY_BEZ_ODKAZU,
      name: "E2E Predajňa Čiapka Polar",
      currency: "EUR",
      price: "14.90",
      stock: 8,
      availabilityInStockText: "Skladom",
      availabilityOutOfStockText: "Vypredané",
      availabilityText: "Skladom",
      productVisibility: "visible",
      state: "sellable",
      firstSeenAt: teraz,
      lastSeenAt: teraz,
      lastSeenSnapshotId: snapshotId,
    },
  ]);

  // Len PRVÝ variant dostane priamu adresu — druhý zámerne ostáva BEZ nej
  // (dôkaz vizuálne odlíšeného náhradného odkazu).
  await db.insert(shopProductUrl).values({
    code: VARIANT_S_ODKAZOM,
    url: "https://www.forestshop.sk/e2e-predajna-bunda-rogaland/",
    fetchedAt: teraz,
  });
}
