// issue 292: "Eshop → Preprava DPD" — vyčlenené z `e2e-setup.ts` (eslint
// `max-lines: 400`, `.claude/rules/testing.md`), rovnaký vzor ako existujúci
// `e2e-fixtures-restock-links.ts`. Jedna objednávka s ÚPLNOU doručovacou
// adresou + dobierkou (appka ju MÁ ponúknuť na výber), jedna s CHÝBAJÚCOU
// adresou (appka ju MÁ zobraziť ako neúplnú, s zablokovaným checkboxom).
import type { Database } from "../apps/api/src/db/client.js";
import { orders, users } from "../apps/api/src/db/schema.js";
import { hashPassword } from "../apps/api/src/modules/auth/passwords.js";

// Musí sa zhodovať s hodnotou v `apps/web/tests/e2e/dpd.spec.ts` — VLASTNÝ
// izolovaný účet (rovnaký mechanizmus ako `E2E_NAVRHY_ODKAZOV_EMAIL` —
// zdieľaný `e2e@forestshop.sk` je už na hranici `MAX_ATTEMPTS`).
export const E2E_DPD_EMAIL = "e2e-dpd@forestshop.sk";

export async function seedDpdFixtures(db: Database, heslo: string): Promise<void> {
  await db.insert(users).values({
    email: E2E_DPD_EMAIL,
    passwordHash: await hashPassword(heslo),
    displayName: "E2E Manažér DPD",
    role: "manazer",
  });

  await db.insert(orders).values({
    externalOrderId: "9012",
    customerName: "E2E Zákazník DPD Pripravená",
    statusName: "Vybavuje sa",
    placedAt: new Date("2026-08-01T09:00:00Z"),
    phone: "+421900111222",
    deliveryFullName: "E2E Zákazník DPD Pripravená",
    deliveryStreet: "Testovacia",
    deliveryHouseNumber: "1",
    deliveryCity: "E2E Mesto",
    deliveryZip: "00000",
    deliveryCountryName: "Slovensko",
    weight: "1.20",
    paymentMethodName: "Dobierka (hotovosť) + karta (len SR)",
    priceToPay: "19.90",
    totalPriceWithVat: "19.90",
  });

  await db.insert(orders).values({
    externalOrderId: "9013",
    customerName: "E2E Zákazník DPD Bez adresy",
    statusName: "Vybavuje sa",
    placedAt: new Date("2026-08-01T09:30:00Z"),
  });
}
