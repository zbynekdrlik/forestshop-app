// issue 337: "Načítať ďalšie" — Playwright e2e dôkaz, že položka NAD prvou
// stranou (`PAGE_SIZE = 50`) je po kliknutí na "Načítať ďalšie" skutočne
// dosiahnuteľná, na obrazovke "Eshop → Párovanie produktov" (#239). 60
// VLASTNÝCH, dovtedy nepoužitých jednovariantných produktov so SPOLOČNÝM
// prefixom kódu ("E2E-PAGE-"), aby dopyt scoped na tento prefix mal `total`
// NEZÁVISLÝ od zvyšku databázy (iné fixtúry/produkty z predošlých issue).
// Bez efektívnej linky (žiadny `internalNote`) — spadajú do predvoleného
// filtra "Bez linky", presne ako `E2E-PL-CHYBA` (`e2e-fixtures-product-
// links.ts`). Žiadny vlastný e2e účet — beží pod `E2E_PAROVANIE_EMAIL`
// (rovnaká obrazovka, čisto ČÍTACÍ dopyt, žiadna mutácia zdieľaného stavu),
// rovnaký mechanizmus ako existujúce testy v `supplier-links.spec.ts`.
import type { Database } from "../apps/api/src/db/client.js";
import { products, variants } from "../apps/api/src/db/schema.js";

export const E2E_PAGE_PREFIX = "E2E-PAGE-";
export const E2E_PAGE_COUNT = 60;

export async function seedPaginationFixtures(db: Database, teraz: Date, snapshotId: string): Promise<void> {
  for (let i = 1; i <= E2E_PAGE_COUNT; i += 1) {
    const key = `${E2E_PAGE_PREFIX}${String(i).padStart(3, "0")}`;
    await db.insert(products).values({ key, name: `E2E Stránkovanie ${key}`, supplier: "E2E Dodávateľ Stránkovanie", internalNote: null, firstSeenAt: teraz, lastSeenAt: teraz, lastSeenSnapshotId: snapshotId });
    await db.insert(variants).values({ code: key, productKey: key, guid: key, name: `E2E Stránkovanie ${key}`, stock: 5, availabilityInStockText: "Skladom", availabilityOutOfStockText: "Vypredané", availabilityText: "Skladom", productVisibility: "visible", state: "sellable", firstSeenAt: teraz, lastSeenAt: teraz, lastSeenSnapshotId: snapshotId });
  }
}
