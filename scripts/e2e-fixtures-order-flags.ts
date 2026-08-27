// issue 290: "Eshop → Výmena tovaru / Vrátený tovar / Reklamácie" —
// vyčlenené do VLASTNÉHO súboru (rovnaký dôvod ako `e2e-fixtures-search.ts`,
// eslint `max-lines: 400`, `.claude/rules/testing.md`). VLASTNÝ izolovaný
// E2E účet (zdieľaný `e2e@forestshop.sk` je už na hranici `MAX_ATTEMPTS`) +
// štyri VLASTNÉ objednávky (externé čísla 92xx, dovtedy nepoužité žiadnym
// iným spec súborom), aby žiadna existujúca "Na objednanie"/prehľadová
// presná asercia nikdy nezachytila tieto stavy. `placedAt` je zámerne PEVNÝ
// dátum HLBOKO V MINULOSTI (rovnaký dôvod ako `e2e-fixtures-search.ts`) —
// NIE `teraz`, inak by tieto 4 objednávky posunuli `orders-overview.spec
// .ts`'s presné "1 objednávka dnes" počty (živo nájdené pri prvom pokuse
// tohto tiketu).
//
// ZÁMERNE BEZ `upozornenie` (`vratenie`) fixtúry — `upozornenie` je
// GLOBÁLNA tabuľka zdieľaná naprieč VŠETKÝMI e2e účtami/spec súbormi
// (rovnaká past ako `.claude/rules/posta-uncollected.md`'s zamietnutý pokus
// o seedovanú kartu pri issue 298): trvalo vložená "vratenie" karta by
// zmenila `upozornenia.spec.ts`'s "žiadne upozornenia" prázdny stav (živo
// overené — presne toto sa stalo pri prvom pokuse). "unresolved" príznak
// (otvorená vratenie karta) preto NEMÁ e2e pokrytie — má ho integračný
// test (`order-flags-http.integration.test.ts`, izolovaná DB per test) a
// vitest komponentový test (`ExchangeOrdersSection.test.tsx`).
import type { Database } from "../apps/api/src/db/client.js";
import { orders, users } from "../apps/api/src/db/schema.js";
import { hashPassword } from "../apps/api/src/modules/auth/passwords.js";

// Musí sa zhodovať s hodnotou v `apps/web/tests/e2e/order-flags.spec.ts`.
export const E2E_OBJEDNAVKY_VYMENA_EMAIL = "e2e-vymena@forestshop.sk";

const MINULY_DATUM = new Date("2026-07-05T09:00:00Z");

export async function seedOrderFlagsFixtures(db: Database, heslo: string): Promise<void> {
  await db.insert(users).values({
    email: E2E_OBJEDNAVKY_VYMENA_EMAIL,
    passwordHash: await hashPassword(heslo),
    displayName: "E2E Manažér Výmena/Vrátenie",
    role: "manazer",
  });

  // issue 514: AKTÍVna výmena (stav "Výmena tovaru") — sekcia „Výmena tovaru"
  // teraz zobrazuje len tieto, nie hotové "Vybavená výmena". Táto jediná
  // fixtúra garantuje viditeľný menu-odznak `nav-badge-exchange` (>0).
  await db.insert(orders).values({
    externalOrderId: "9201",
    customerName: "E2E Zákazník Výmena",
    statusName: "Výmena tovaru",
    placedAt: MINULY_DATUM,
    totalPriceWithVat: "30.00",
  });

  await db.insert(orders).values({
    externalOrderId: "9202",
    customerName: "E2E Zákazník Vrátenie",
    statusName: "Vratený tovar",
    placedAt: MINULY_DATUM,
    totalPriceWithVat: "18.50",
  });

  // "Reklamácie" — už OZNAČENÁ (appka nemá seedovací endpoint, priamy zápis
  // do stĺpca je jediná cesta pre pred-pripravenú fixtúru). `claim_marked_at`
  // NIE JE globálne zdieľaná tabuľka ako `upozornenie` vyššie — je to stĺpec
  // na TEJTO konkrétnej objednávke, nijaký iný spec súbor sa naň nepozerá.
  await db.insert(orders).values({
    externalOrderId: "9203",
    customerName: "E2E Zákazník Reklamácia",
    statusName: "Vybavená",
    placedAt: MINULY_DATUM,
    totalPriceWithVat: "9.90",
    claimMarkedAt: MINULY_DATUM,
    claimNote: "e2e — vopred označená reklamácia",
  });

  // BEZ reklamácie — na túto obsluha v e2e teste sama klikne "Označiť ako
  // reklamáciu" a potom "Zrušiť reklamáciu", aby sa overil celý zápisový cyklus.
  await db.insert(orders).values({
    externalOrderId: "9204",
    customerName: "E2E Zákazník Bez Reklamácie",
    statusName: "Vybavená",
    placedAt: MINULY_DATUM,
    totalPriceWithVat: "5.00",
  });
}
