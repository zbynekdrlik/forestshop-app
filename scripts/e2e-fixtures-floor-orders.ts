// issue 345: "Eshop → Objednávky predajňa" — vyčlenené do VLASTNÉHO súboru
// (rovnaký dôvod ako `e2e-fixtures-order-flags.ts`, eslint `max-lines: 400`,
// `.claude/rules/testing.md`). VLASTNÝ izolovaný E2E účet (zdieľaný
// `e2e@forestshop.sk` je už na hranici `MAX_ATTEMPTS`) + 11 VLASTNÝCH
// objednávok s dopravou "Osobný odber" (PAGE_SIZE + 1 = 11, aby
// "Načítať ďalšie" malo čo reálne odhaliť na druhej strane) + 1 objednávka
// s INOU dopravou (nesmie sa nikdy objaviť — dôkaz, že filter naozaj
// filtruje). `placedAt` je zámerne PEVNÝ dátum HLBOKO V MINULOSTI (rovnaký
// dôvod ako `e2e-fixtures-order-flags.ts`) — NIE `teraz`, aby tieto
// objednávky neposunuli iné presné "objednávky dnes" počty.
import type { Database } from "../apps/api/src/db/client.js";
import { orders, users } from "../apps/api/src/db/schema.js";
import { hashPassword } from "../apps/api/src/modules/auth/passwords.js";

// Musí sa zhodovať s hodnotou v `apps/web/tests/e2e/floor-orders.spec.ts`.
export const E2E_OBJEDNAVKY_PREDAJNA_EMAIL = "e2e-predajna@forestshop.sk";

// PAGE_SIZE z `floorOrdersApi.ts` (10) + 1, aby prvá strana bola PLNÁ a
// druhá strana mala presne JEDEN riadok navyše — jednoznačný dôkaz, že
// "Načítať ďalšie" naozaj siahlo za prvú stranu.
const POCET_PREDAJNA = 11;

export async function seedFloorOrdersFixtures(db: Database, heslo: string): Promise<void> {
  await db.insert(users).values({
    email: E2E_OBJEDNAVKY_PREDAJNA_EMAIL,
    passwordHash: await hashPassword(heslo),
    displayName: "E2E Manažér Predajňa",
    role: "manazer",
  });

  for (let i = 1; i <= POCET_PREDAJNA; i += 1) {
    await db.insert(orders).values({
      externalOrderId: `93${String(i).padStart(3, "0")}`,
      customerName: `E2E Zákazník Predajňa ${String(i).padStart(2, "0")}`,
      statusName: "Vybavená",
      shippingCarrierName: "Osobný odber - len na predajni v POPRADE!",
      // Rastúci dátum → posledná vložená (i = 11) je NAJNOVŠIA, musí byť
      // prvá na obrazovke ("Najnovšie hore" — zadanie tiketu).
      placedAt: new Date(2026, 5, i, 9, 0, 0),
      totalPriceWithVat: `${String(10 + i)}.00`,
    });
  }

  // INÁ doprava — nesmie sa nikdy objaviť na "Objednávky predajňa".
  await db.insert(orders).values({
    externalOrderId: "93999",
    customerName: "E2E Zákazník Kuriér",
    statusName: "Vybavená",
    shippingCarrierName: "Kuriér",
    placedAt: new Date("2026-06-20T09:00:00Z"),
    totalPriceWithVat: "99.00",
  });
}
