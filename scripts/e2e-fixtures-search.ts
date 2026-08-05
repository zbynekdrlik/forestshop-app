// issue 240: "Eshop → Vyhľadať" — vyčlenené do VLASTNÉHO súboru (rovnaký
// dôvod ako `e2e-fixtures-product-links.ts`, issue 239 — eslint `max-lines:
// 400`, `.claude/rules/testing.md`). VLASTNÝ, dovtedy nepoužitý produkt +
// variant (nekoliduje so žiadnym existujúcim testom, ktorý by naň spoliehal
// presným počtom/hodnotou) a VLASTNÁ objednávka BEZ `order_line` (aby sa
// nedotkla `orders.spec.ts`'s presných "Všetci (N)" počtov ani
// `orders-overview.spec.ts`'s "1 objednávka dnes" — `placedAt` je preto
// zámerne PEVNÝ dátum v minulosti, nie "teraz").
import type { Database } from "../apps/api/src/db/client.js";
import { orders, products, shopProductUrl, supplierStock, users, variants } from "../apps/api/src/db/schema.js";
import { hashPassword } from "../apps/api/src/modules/auth/passwords.js";
import { DEFAULT_ORDER_OPEN_STATUS } from "../apps/api/src/modules/orders/open-statuses.js";

// Musí sa zhodovať s hodnotou v `apps/web/tests/e2e/search.spec.ts` —
// VLASTNÝ izolovaný účet (rovnaký mechanizmus ako `E2E_PAROVANIE_EMAIL` v
// `e2e-fixtures-product-links.ts` — zdieľaný `e2e@forestshop.sk` je už na
// hranici `MAX_ATTEMPTS`).
export const E2E_VYHLADAT_EMAIL = "e2e-vyhladat@forestshop.sk";

const PRODUCT_KEY = "E2E-SEARCH-1";
const VARIANT_CODE = "E2E-SEARCH-1";
const SUPPLIER_LINK = "https://e2e-dodavatel.example.com/vyhladat-produkt";

export async function seedSearchFixtures(db: Database, teraz: Date, snapshotId: string, heslo: string): Promise<void> {
  await db.insert(users).values({
    email: E2E_VYHLADAT_EMAIL,
    passwordHash: await hashPassword(heslo),
    displayName: "E2E Manažér Vyhľadávanie",
    role: "manazer",
  });

  await db.insert(products).values({
    key: PRODUCT_KEY,
    name: "E2E Vyhľadávací Produkt Alfa",
    supplier: "E2E Dodávateľ Vyhľadávanie",
    internalNote: `Dodávateľ: ${SUPPLIER_LINK}`,
    firstSeenAt: teraz,
    lastSeenAt: teraz,
    lastSeenSnapshotId: snapshotId,
  });
  await db.insert(variants).values({
    code: VARIANT_CODE,
    productKey: PRODUCT_KEY,
    guid: PRODUCT_KEY,
    externalCode: "EXT-VYHLADAT-1",
    name: "E2E Vyhľadávací Produkt Alfa",
    currency: "EUR",
    price: "24.90",
    stock: 3,
    availabilityInStockText: "Skladom",
    availabilityOutOfStockText: "Vypredané",
    availabilityText: "Skladom",
    productVisibility: "visible",
    state: "sellable",
    firstSeenAt: teraz,
    lastSeenAt: teraz,
    lastSeenSnapshotId: snapshotId,
  });

  await db.insert(shopProductUrl).values({
    code: VARIANT_CODE,
    url: "https://www.forestshop.sk/e2e-vyhladat-produkt/",
    fetchedAt: teraz,
  });

  await db.insert(supplierStock).values({
    link: SUPPLIER_LINK,
    sizeLabel: "",
    host: "e2e-dodavatel.example.com",
    availability: "available",
    availabilityText: "Skladom u e2e dodávateľa",
    source: "text",
    ok: true,
    checkedAt: teraz,
    confirmedAt: teraz,
  });

  // Zámerne BEZ `order_line` (viď komentár na vrchu súboru) a s dátumom
  // hlboko v minulosti — `orders.spec.ts`/`orders-overview.spec.ts` počítajú
  // s presnými číslami, ktoré táto objednávka nesmie posunúť.
  await db.insert(orders).values({
    externalOrderId: "9101",
    customerName: "E2E Zákazník Vyhľadávanie",
    email: "e2e-vyhladat-zakaznik@example.com",
    statusName: DEFAULT_ORDER_OPEN_STATUS,
    placedAt: new Date("2026-07-10T09:00:00Z"),
  });
}
