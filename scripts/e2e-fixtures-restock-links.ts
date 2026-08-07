// issue 311: "Vypredané → Skladom: návrhy odkazov" — vyčlenené z
// `e2e-setup.ts` (eslint `max-lines: 400`, `.claude/rules/testing.md`),
// rovnaký vzor ako existujúci `e2e-fixtures-product-links.ts` (#239). DVA
// VLASTNÉ, dovtedy nepoužité jednovariantné produkty: jeden vypredaný,
// viditeľný, stále v exporte, BEZ efektívnej linky (kandidát na návrh),
// druhý s UŽ ULOŽENOU linkou (`internalNote`) a prekrývajúcimi sa slovami
// názvu + ROVNAKÝM dodávateľom (zdroj návrhu). Tretí, s NEsúvisiacim menom
// a CUDZÍM dodávateľom, dokazuje, že sa nikdy nenavrhne bez zhody.
import type { Database } from "../apps/api/src/db/client.js";
import { products, users, variants } from "../apps/api/src/db/schema.js";
import { hashPassword } from "../apps/api/src/modules/auth/passwords.js";

// Musí sa zhodovať s hodnotou v `apps/web/tests/e2e/restock-links.spec.ts` —
// VLASTNÝ izolovaný účet (rovnaký mechanizmus ako `E2E_PAROVANIE_EMAIL` —
// zdieľaný `e2e@forestshop.sk` je už na hranici `MAX_ATTEMPTS`).
export const E2E_NAVRHY_ODKAZOV_EMAIL = "e2e-navrhy-odkazov@forestshop.sk";

export async function seedRestockLinksFixtures(db: Database, teraz: Date, snapshotId: string, heslo: string): Promise<void> {
  await db.insert(users).values({
    email: E2E_NAVRHY_ODKAZOV_EMAIL,
    passwordHash: await hashPassword(heslo),
    displayName: "E2E Manažér",
    role: "manazer",
  });

  async function seedProdukt(
    key: string,
    code: string,
    name: string,
    over: { readonly internalNote?: string | null; readonly state?: "sellable" | "out_of_stock" } = {},
  ): Promise<void> {
    await db.insert(products).values({
      key,
      name,
      supplier: "E2E Dodávateľ Návrhy",
      internalNote: over.internalNote ?? null,
      firstSeenAt: teraz,
      lastSeenAt: teraz,
      lastSeenSnapshotId: snapshotId,
    });
    await db.insert(variants).values({
      code,
      productKey: key,
      guid: key,
      name,
      stock: over.state === "out_of_stock" ? 0 : 5,
      availabilityInStockText: "Skladom",
      availabilityOutOfStockText: "Vypredané",
      availabilityText: over.state === "out_of_stock" ? "Vypredané" : "Skladom",
      productVisibility: "visible",
      state: over.state ?? "sellable",
      firstSeenAt: teraz,
      lastSeenAt: teraz,
      lastSeenSnapshotId: snapshotId,
    });
  }

  await seedProdukt("E2E-RL-CHYBA", "E2E-RL-CHYBA", "E2E Bunda Alfa Vypredaná", { state: "out_of_stock" });
  await seedProdukt("E2E-RL-NAVRH", "E2E-RL-NAVRH", "E2E Bunda Alfa Skladom", {
    internalNote: "https://e2e-dodavatel.example.com/bunda-alfa-navrh",
  });
  await db.insert(products).values({
    key: "E2E-RL-CUDZI",
    name: "E2E Šál Zeta Cudzí",
    supplier: "E2E Iný Dodávateľ",
    internalNote: "https://iny-dodavatel.example.com/sal-zeta",
    firstSeenAt: teraz,
    lastSeenAt: teraz,
    lastSeenSnapshotId: snapshotId,
  });
  await db.insert(variants).values({
    code: "E2E-RL-CUDZI",
    productKey: "E2E-RL-CUDZI",
    guid: "E2E-RL-CUDZI",
    name: "E2E Šál Zeta Cudzí",
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
