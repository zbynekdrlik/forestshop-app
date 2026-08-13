import type { Database } from "../../src/db/client.js";
import { pairingCandidates, pairingCandidateSets, products, variants } from "../../src/db/schema.js";

// issue 387 E5/E6 — zdieľané seed helpery pre `pairing-review-http
// .integration.test.ts` (E5, čítanie) aj `pairing-review-decisions-http
// .integration.test.ts` (E6, rozhodnutia) — vyčlenené SEM, aby ani jeden
// súbor nenarástol cez eslint `max-lines: 400` (`.claude/rules/testing.md`'s
// zavedený vzor: `orders-http.integration.test.ts`/`orders-http-state
// .integration.test.ts` split).

export async function seedPairingReviewProduct(
  db: Database,
  snapshotId: string,
  productKey: string,
  over: {
    readonly name: string;
    readonly supplier?: string | null;
    readonly internalNote?: string | null;
    readonly variants?: readonly {
      readonly code: string;
      readonly externalCode?: string | null;
      readonly state?: "sellable" | "out_of_stock" | "discontinued";
      readonly productVisibility?: string;
      readonly missingSince?: Date | null;
      readonly price?: string | null;
    }[];
  },
): Promise<void> {
  const now = new Date("2026-08-13T00:00:00Z");
  await db.insert(products).values({
    key: productKey,
    name: over.name,
    supplier: over.supplier ?? null,
    internalNote: over.internalNote ?? null,
    firstSeenAt: now,
    lastSeenAt: now,
    lastSeenSnapshotId: snapshotId,
  });
  const variantSpecs = over.variants ?? [{ code: `${productKey}/1` }];
  for (const v of variantSpecs) {
    await db.insert(variants).values({
      code: v.code,
      productKey,
      guid: productKey,
      externalCode: v.externalCode ?? null,
      name: over.name,
      price: v.price ?? null,
      stock: 0,
      availabilityInStockText: "Skladom",
      availabilityOutOfStockText: "Vypredané",
      availabilityText: v.state === "out_of_stock" ? "Vypredané" : "Skladom",
      productVisibility: v.productVisibility ?? "visible",
      state: v.state ?? "sellable",
      missingSince: v.missingSince ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
      lastSeenSnapshotId: snapshotId,
    });
  }
}

export async function seedPairingCandidateSet(
  db: Database,
  productKey: string,
  over: {
    readonly chosenUrl?: string | null;
    readonly confidence?: "high" | "medium" | "low" | "none";
    readonly verdict?: "ok" | "unsure" | null;
    readonly candidates?: readonly {
      readonly url: string;
      readonly name: string;
      readonly rawScore: string;
      readonly codeHit: boolean;
      /** issue 397 — voliteľné, `undefined`/chýbajúce necháva DB default (`null`). */
      readonly imageUrl?: string | null;
    }[];
  } = {},
): Promise<void> {
  await db.insert(pairingCandidateSets).values({
    productKey,
    gatheredAt: new Date("2026-08-13T03:35:00Z"),
    queries: ["dopyt"],
    inputHash: "hash-" + productKey,
    chosenUrl: over.chosenUrl ?? null,
    chosenReason: over.chosenUrl !== undefined && over.chosenUrl !== null ? "najlepší nájdený" : null,
    confidence: over.confidence ?? (over.chosenUrl !== undefined && over.chosenUrl !== null ? "medium" : "none"),
    verdict: over.verdict ?? null,
    verdictCheckedAt: over.verdict !== undefined && over.verdict !== null ? new Date("2026-08-13T03:36:00Z") : null,
  });
  for (const [i, c] of (over.candidates ?? []).entries()) {
    await db.insert(pairingCandidates).values({
      productKey,
      position: i,
      name: c.name,
      url: c.url,
      imageUrl: c.imageUrl ?? null,
      rawScore: c.rawScore,
      codeHit: c.codeHit,
    });
  }
}
