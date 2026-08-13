// issue 387 E5: "Eshop → Párovanie" — vyčlenené z `e2e-setup.ts` (eslint
// `max-lines: 400`, `.claude/rules/testing.md`), rovnaký vzor ako existujúci
// `e2e-fixtures-restock-links.ts` (#311). TRI VLASTNÉ, dovtedy nepoužité
// jednovariantné produkty, každý s vlastným `pairing_candidate_set` riadkom
// (E5's populácia = "produkty S kandidátmi", INNER JOIN): jeden BEZ
// efektívnej linky s napárovaným kandidátom ("unreviewed" + "matched"),
// jeden BEZ efektívnej linky bez kandidáta ("unreviewed" + "unmatched" —
// dokazuje "Nenašiel sa žiadny kandidát" stav), a jeden UŽ S linkou
// (dokazuje, že "unreviewed" filter/odznak ho vylúči — design komentár na
// tickete, issue 387 E5).
import type { Database } from "../apps/api/src/db/client.js";
import { pairingCandidates, pairingCandidateSets, products, users, variants } from "../apps/api/src/db/schema.js";
import { hashPassword } from "../apps/api/src/modules/auth/passwords.js";

// Musí sa zhodovať s hodnotou v `apps/web/tests/e2e/pairing-review.spec.ts` —
// VLASTNÝ izolovaný účet (rovnaký mechanizmus ako `E2E_NAVRHY_ODKAZOV_EMAIL` —
// zdieľaný `e2e@forestshop.sk` je už na hranici `MAX_ATTEMPTS`).
export const E2E_PAROVANIE_REVIEW_EMAIL = "e2e-parovanie-review@forestshop.sk";

export async function seedPairingReviewFixtures(db: Database, teraz: Date, snapshotId: string, heslo: string): Promise<void> {
  await db.insert(users).values({
    email: E2E_PAROVANIE_REVIEW_EMAIL,
    passwordHash: await hashPassword(heslo),
    displayName: "E2E Manažér",
    role: "manazer",
  });

  async function seedProdukt(key: string, name: string, over: { readonly internalNote?: string | null } = {}): Promise<void> {
    await db.insert(products).values({
      key,
      name,
      supplier: "E2E Dodávateľ Párovanie",
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

  await seedProdukt("E2E-PR-CHYBA", "E2E Bunda Alfa Nezrevidovaná");
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
    rawScore: "85.0000",
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
}
