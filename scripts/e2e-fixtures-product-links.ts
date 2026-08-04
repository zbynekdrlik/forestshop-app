// issue 239: "Eshop → Párovanie produktov" — vyčlenené z `e2e-setup.ts`
// (eslint `max-lines: 400`, `.claude/rules/testing.md`), rovnaký vzor ako
// existujúci test-súborový split (`orders-http.integration.test.ts` /
// `orders-http-state.integration.test.ts`). DVA VLASTNÉ, dovtedy nepoužité
// jednovariantné produkty (žiadny `order_line` na ne odkazuje, takže sa
// nedostanú do "Na objednanie"/žiadny iný test nad nimi nič nepočíta):
// jeden BEZ efektívnej linky (žiadny `internalNote`, žiadny override — pre
// "doplniť" cestu), druhý s UŽ ULOŽENÝM, ešte NEODOSLANÝM override (pre
// "opraviť existujúcu" cestu). Priamy insert (rovnaký vzor ako
// `e2e-setup.ts`'s `seedPrepinanieKandidata`) — tento skript je MIMO
// `apps/api` TS projektu, takže si nepožičiava testové pomôcky z
// `apps/api/tests/helpers`.
import type { Database } from "../apps/api/src/db/client.js";
import { productSupplierLinkOverrides, products, users, variants } from "../apps/api/src/db/schema.js";
import { hashPassword } from "../apps/api/src/modules/auth/passwords.js";

// Musí sa zhodovať s hodnotou v `apps/web/tests/e2e/supplier-links.spec.ts`
// — VLASTNÝ izolovaný účet (rovnaký mechanizmus ako `e2e-setup.ts`'s
// `E2E_PREHLAD_EMAIL`/ostatné — zdieľaný `e2e@forestshop.sk` je už na
// hranici `MAX_ATTEMPTS`).
export const E2E_PAROVANIE_EMAIL = "e2e-parovanie@forestshop.sk";

export async function seedProductLinksFixtures(db: Database, teraz: Date, snapshotId: string, heslo: string): Promise<void> {
  await db.insert(users).values({
    email: E2E_PAROVANIE_EMAIL,
    passwordHash: await hashPassword(heslo),
    displayName: "E2E Manažér",
    role: "manazer",
  });

  async function seedParovanieProduktu(key: string): Promise<void> {
    await db.insert(products).values({
      key,
      name: `E2E Produkt Párovanie ${key}`,
      supplier: "E2E Dodávateľ Párovanie",
      internalNote: null,
      firstSeenAt: teraz,
      lastSeenAt: teraz,
      lastSeenSnapshotId: snapshotId,
    });
    await db.insert(variants).values({
      code: key,
      productKey: key,
      guid: key,
      name: `E2E Produkt Párovanie ${key}`,
      stock: 5,
      availabilityInStockText: "Skladom",
      availabilityOutOfStockText: "Vypredané",
      availabilityText: "Skladom",
      productVisibility: "visible",
      state: "sellable",
      firstSeenAt: teraz,
      lastSeenAt: teraz,
      lastSeenSnapshotId: snapshotId,
    });
  }
  await seedParovanieProduktu("E2E-PL-CHYBA");
  await seedParovanieProduktu("E2E-PL-OPRAVA");
  await db.insert(productSupplierLinkOverrides).values({
    productKey: "E2E-PL-OPRAVA",
    url: "https://e2e-dodavatel.example.com/parovanie-oprava-povodna",
    updatedAt: new Date("2026-07-20T09:00:00Z"),
  });
}
