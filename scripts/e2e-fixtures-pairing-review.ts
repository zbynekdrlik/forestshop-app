// issue 387 E5: "Eshop → Párovanie" — vyčlenené z `e2e-setup.ts` (eslint
// `max-lines: 400`, `.claude/rules/testing.md`), rovnaký vzor ako existujúci
// `e2e-fixtures-restock-links.ts` (#311).
//
// issue 398/401/409 — fixtúry rozšírené o: `suppliers` riadok pre "E2E
// Dodávateľ Párovanie" (adapterKey vyplnený — bez neho by `supplierHasAdapter`
// vyšlo `false` pre VŠETKY existujúce fixtúry, keďže `withCleanDb`/
// `e2e-setup.ts` truncatuje `supplier` tabuľku a NEreseeduje migračný
// WETLAND/BETALOV/ODIMON seed — rovnaký ustálený vzor, aký `pairing-search
// -run.integration.test.ts`/`pairing-search-verify.integration.test.ts` už
// používajú: test si vlastný `suppliers` riadok vloží SÁM, nikdy sa
// nespolieha na migračný seed), produkt BEZ adaptéra (#401 — nová plná
// populácia) a produkt s DRUHÝM (nevybraným) kandidátom s vlastným
// obrázkom (#409 — panel ukazuje obrázok KAŽDÉHO z top-8).
import type { Database } from "../apps/api/src/db/client.js";
import { pairingCandidates, pairingCandidateSets, products, shopProductUrl, suppliers, users, variants } from "../apps/api/src/db/schema.js";
import { hashPassword } from "../apps/api/src/modules/auth/passwords.js";

// Musí sa zhodovať s hodnotou v `apps/web/tests/e2e/pairing-review.spec.ts` —
// VLASTNÝ izolovaný účet (rovnaký mechanizmus ako `E2E_NAVRHY_ODKAZOV_EMAIL` —
// zdieľaný `e2e@forestshop.sk` je už na hranici `MAX_ATTEMPTS`).
export const E2E_PAROVANIE_REVIEW_EMAIL = "e2e-parovanie-review@forestshop.sk";

// issue 397 — `<img src>` obrázkové URL pre e2e fixtúry MUSIA byť `data:`
// URI, nikdy skutočná (aj keď zámerne neplatná) `https://` adresa —
// prehliadač sa REÁLNE pokúsi obrázok stiahnuť (Playwright beží proti
// skutočnému Chromiu), takže vymyslená `https://e2e-*.example.com/img/…`
// URL vyrobí skutočnú `net::ERR_NAME_NOT_RESOLVED`/404 konzolovú chybu —
// presne to, čo `.claude/rules/testing.md`'s "konzola je čistá" zákaz
// rozširovania výnimiek zakazuje. `data:` URI sa vykreslí OKAMŽITE, bez
// akéhokoľvek sieťového volania. DVE ODLIŠNÉ 1×1px PNG (červená/modrá) —
// nikdy tá istá hodnota pre obe strany, inak by test prešiel aj keby appka
// omylom zamenila náš a kandidátov obrázok. Musia sa zhodovať s hodnotami
// v `apps/web/tests/e2e/pairing-review.spec.ts`.
export const E2E_OUR_IMAGE_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
export const E2E_CANDIDATE_IMAGE_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";
// issue 409 — TRETÍ, odlišný obrázok pre ALTERNATÍVNEHO (nevybraného)
// kandidáta v paneli (E2E-PR-PANEL nižšie) — zelený 1×1px PNG.
export const E2E_ALT_CANDIDATE_IMAGE_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const ADAPTER_SUPPLIER_NAME = "E2E Dodávateľ Párovanie";
// issue 401 — dodávateľ ZÁMERNE bez `suppliers` riadku vôbec — presne
// scenár "dodávateľ zatiaľ nemá automatické vyhľadávanie".
const NO_ADAPTER_SUPPLIER_NAME = "E2E Dodávateľ Bez Adaptéra";

export async function seedPairingReviewFixtures(db: Database, teraz: Date, snapshotId: string, heslo: string): Promise<void> {
  await db.insert(users).values({
    email: E2E_PAROVANIE_REVIEW_EMAIL,
    passwordHash: await hashPassword(heslo),
    displayName: "E2E Manažér",
    role: "manazer",
  });

  await db.insert(suppliers).values({
    name: ADAPTER_SUPPLIER_NAME,
    currency: "EUR",
    wholesaleBaseUrl: "https://e2e-dodavatel.example.com",
    adapterKey: "wetland",
  });

  async function seedProdukt(
    key: string,
    name: string,
    over: {
      readonly internalNote?: string | null;
      readonly supplier?: string;
      // issue 422 — voliteľné, chýbajúce necháva PÔVODNÉ správanie
      // (žiadna cena, stock 5, "Skladom") — existujúce volania sa nemenia.
      readonly price?: string;
      readonly standardPrice?: string;
      readonly stock?: number;
    } = {},
  ): Promise<void> {
    await db.insert(products).values({
      key,
      name,
      supplier: over.supplier ?? ADAPTER_SUPPLIER_NAME,
      internalNote: over.internalNote ?? null,
      firstSeenAt: teraz,
      lastSeenAt: teraz,
      lastSeenSnapshotId: snapshotId,
    });
    await db.insert(variants).values({
      code: key,
      productKey: key,
      guid: key,
      externalCode: `${key}-KOD`,
      name,
      // `variant_money_needs_currency_ck` (`.claude/rules/database.md`) —
      // menu treba nastaviť VŽDY, keď je nastavená hociktorá cena.
      currency: over.price !== undefined || over.standardPrice !== undefined ? "EUR" : null,
      price: over.price ?? null,
      standardPrice: over.standardPrice ?? null,
      stock: over.stock ?? 5,
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

  // issue 422 — cena/pôvodná cena/sklad na TOMTO produkte, aby jediný e2e
  // test (`pairing-review.spec.ts`'s prvý test) overil AJ "naša strana" polia
  // (chosenReason už mala táto fixtúra dávno, pozri pairingCandidateSets nižšie).
  await seedProdukt("E2E-PR-CHYBA", "E2E Bunda Alfa Nezrevidovaná", { price: "49.90", standardPrice: "59.90", stock: 3 });
  await db.insert(pairingCandidateSets).values({
    productKey: "E2E-PR-CHYBA",
    gatheredAt: teraz,
    queries: ["e2e bunda alfa"],
    inputHash: "e2e-hash-chyba",
    chosenUrl: "https://e2e-dodavatel.example.com/bunda-alfa-navrh",
    chosenReason: "najlepší nájdený",
    confidence: "medium",
    verdict: null,
  });
  await db.insert(pairingCandidates).values({
    productKey: "E2E-PR-CHYBA",
    position: 0,
    name: "E2E Bunda Alfa u dodávateľa",
    url: "https://e2e-dodavatel.example.com/bunda-alfa-navrh",
    // issue 397 — OBA obrázky na karte: kandidátov (tu) aj náš vlastný
    // (shopProductUrl riadok nižšie) — presne to, čo `pairing-review.spec
    // .ts`'s nová kontrola overuje.
    imageUrl: E2E_CANDIDATE_IMAGE_DATA_URI,
    rawScore: "85.0000",
    codeHit: false,
  });
  // issue 397 — náš vlastný obrázok (`shop_product_url`, feed google.xml,
  // `.claude/rules/shop-feed.md`) kľúčovaný podľa variant.code (= `key`,
  // `seedProdukt` vyššie).
  await db.insert(shopProductUrl).values({
    code: "E2E-PR-CHYBA",
    url: "https://www.forestshop.sk/e2e-bunda-alfa",
    imageUrl: E2E_OUR_IMAGE_DATA_URI,
    fetchedAt: teraz,
  });

  // issue 399 — "✂ Rozdeliť na veľkosti" + "Hľadať / opraviť": jediný
  // fixtúrový produkt v tomto súbore s VIAC ako 1 variantom (`seedProdukt`
  // vyššie vždy vytvorí presne jeden, `code === productKey`) — potrebný na
  // to, aby `PairingReviewCard.tsx`'s `variantCount > 1` podmienka split
  // tlačidlo vôbec zobrazila. Dva sellable/visible varianty (S/M) posúvajú
  // `catalog.spec.ts`'s pevné počty o +2 (`.claude/rules/testing.md`'s
  // dokumentovaná pasca) — zdokumentované priamo tam.
  await db.insert(products).values({
    key: "E2E-PR-SPLIT",
    name: "E2E Bunda Gama Viacveľkostná",
    supplier: ADAPTER_SUPPLIER_NAME,
    internalNote: null,
    firstSeenAt: teraz,
    lastSeenAt: teraz,
    lastSeenSnapshotId: snapshotId,
  });
  await db.insert(variants).values([
    {
      code: "E2E-PR-SPLIT/S",
      productKey: "E2E-PR-SPLIT",
      guid: "E2E-PR-SPLIT",
      sizeLabel: "S",
      externalCode: "E2E-PR-SPLIT-S-KOD",
      name: "E2E Bunda Gama Viacveľkostná",
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
      code: "E2E-PR-SPLIT/M",
      productKey: "E2E-PR-SPLIT",
      guid: "E2E-PR-SPLIT",
      sizeLabel: "M",
      externalCode: "E2E-PR-SPLIT-M-KOD",
      name: "E2E Bunda Gama Viacveľkostná",
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
  ]);
  await db.insert(pairingCandidateSets).values({
    productKey: "E2E-PR-SPLIT",
    gatheredAt: teraz,
    queries: ["e2e bunda gama"],
    inputHash: "e2e-hash-split",
    chosenUrl: "https://e2e-dodavatel.example.com/bunda-gama-navrh",
    chosenReason: "najlepší nájdený",
    confidence: "medium",
    verdict: null,
  });
  await db.insert(pairingCandidates).values({
    productKey: "E2E-PR-SPLIT",
    position: 0,
    name: "E2E Bunda Gama u dodávateľa",
    url: "https://e2e-dodavatel.example.com/bunda-gama-navrh",
    imageUrl: null,
    rawScore: "80.0000",
    codeHit: false,
  });

  await seedProdukt("E2E-PR-NENAJDENY", "E2E Produkt Bez Kandidáta");
  await db.insert(pairingCandidateSets).values({
    productKey: "E2E-PR-NENAJDENY",
    gatheredAt: teraz,
    queries: ["e2e produkt bez kandidáta"],
    inputHash: "e2e-hash-nenajdeny",
    chosenUrl: null,
    chosenReason: null,
    confidence: "none",
    verdict: null,
  });

  await seedProdukt("E2E-PR-SLINKOU", "E2E Produkt Už S Linkou", {
    internalNote: "https://e2e-dodavatel.example.com/uz-ma-linku",
  });
  await db.insert(pairingCandidateSets).values({
    productKey: "E2E-PR-SLINKOU",
    gatheredAt: teraz,
    queries: ["e2e produkt už s linkou"],
    inputHash: "e2e-hash-slinkou",
    chosenUrl: null,
    chosenReason: null,
    confidence: "none",
    verdict: null,
  });

  // issue 401 — dodávateľ BEZ adaptéra: ŽIADEN `pairing_candidate_set`
  // riadok vôbec (gather preň nikdy nebeží), ŽIADNA efektívna linka —
  // ukazuje kartu bez kandidátov, s hláškou "zatiaľ nemá automatické
  // vyhľadávanie" (nie "Nenašiel sa žiadny kandidát").
  await seedProdukt("E2E-PR-BEZADAPTERA", "E2E Produkt Bez Adaptéra", { supplier: NO_ADAPTER_SUPPLIER_NAME });

  // issue 409 — DVA kandidáti: prvý (chosen) MÁ obrázok, druhý (alternatívny,
  // nevybraný) MÁ VLASTNÝ iný obrázok — panel musí ukázať OBA nezávisle.
  // Vlastný, dovtedy nepoužitý produkt (nikdy sa nerozhoduje inde v súbore),
  // aby ho žiadny INÝ test v behu netrafil/nezmenil.
  await seedProdukt("E2E-PR-PANEL", "E2E Bunda Beta Panel");
  await db.insert(pairingCandidateSets).values({
    productKey: "E2E-PR-PANEL",
    gatheredAt: teraz,
    queries: ["e2e bunda beta"],
    inputHash: "e2e-hash-panel",
    chosenUrl: "https://e2e-dodavatel.example.com/bunda-beta-navrh",
    chosenReason: "najlepší nájdený",
    confidence: "medium",
    verdict: null,
  });
  await db.insert(pairingCandidates).values([
    {
      productKey: "E2E-PR-PANEL",
      position: 0,
      name: "E2E Bunda Beta u dodávateľa",
      url: "https://e2e-dodavatel.example.com/bunda-beta-navrh",
      imageUrl: E2E_CANDIDATE_IMAGE_DATA_URI,
      rawScore: "85.0000",
      codeHit: false,
    },
    {
      productKey: "E2E-PR-PANEL",
      position: 1,
      name: "E2E Bunda Beta Alternatíva",
      url: "https://e2e-dodavatel.example.com/bunda-beta-alt",
      imageUrl: E2E_ALT_CANDIDATE_IMAGE_DATA_URI,
      rawScore: "60.0000",
      codeHit: false,
    },
  ]);
}
