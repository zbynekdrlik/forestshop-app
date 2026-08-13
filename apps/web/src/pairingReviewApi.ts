import { z } from "zod";

// issue 387 E5: "Eshop → Párovanie" — zrkadlí `GET /api/pairing-review`
// (`apps/api/src/http/pairing-review-routes.ts`). issue 387 E6 pridáva
// rozhodnutia: `sendPairingDecision`/`fetchPairingCandidates` + `decision`
// pole v položke.

export const PAIRING_REVIEW_FILTERS = ["unreviewed", "matched", "unmatched", "st1", "st2", "st3", "all"] as const;
export type PairingReviewFilter = (typeof PAIRING_REVIEW_FILTERS)[number];

const chosenCandidateSchema = z.object({
  name: z.string(),
  url: z.string(),
  rawScore: z.number(),
  codeHit: z.boolean(),
});

export const PAIRING_DECISION_STATUSES = ["good", "manual", "unavailable", "discontinued"] as const;
export type PairingDecisionStatus = (typeof PAIRING_DECISION_STATUSES)[number];

const decisionSchema = z.object({
  status: z.enum(PAIRING_DECISION_STATUSES),
  url: z.string().nullable(),
  decidedAt: z.string(),
});
export type PairingReviewDecision = z.infer<typeof decisionSchema>;

const itemSchema = z.object({
  productKey: z.string(),
  productName: z.string(),
  supplier: z.string().nullable(),
  externalCodes: z.array(z.string()),
  variantCount: z.number(),
  productState: z.enum(["sellable", "out_of_stock", "discontinued"]),
  priceMin: z.string().nullable(),
  priceMax: z.string().nullable(),
  currency: z.string().nullable(),
  ourUrl: z.string(),
  ourUrlIsSearchFallback: z.boolean(),
  ourImageUrl: z.string().nullable(),
  hasEffectiveLink: z.boolean(),
  gatheredAt: z.string(),
  confidence: z.enum(["high", "medium", "low", "none"]),
  chosenReason: z.string().nullable(),
  verdict: z.enum(["ok", "unsure"]).nullable(),
  chosenCandidate: chosenCandidateSchema.nullable(),
  decision: decisionSchema.nullable(),
});
export type PairingReviewItem = z.infer<typeof itemSchema>;

const searchSchema = z.object({
  total: z.number(),
  gatheredTotal: z.number(),
  linkedTotal: z.number(),
  items: z.array(itemSchema),
});
export type PairingReviewSearchResult = z.infer<typeof searchSchema>;

export const PAGE_SIZE = 50;

/** Relácia medzitým vypršala (401) — rovnaký vzor ako ostatné čítacie API klienty. */
export class PairingReviewUnauthorizedError extends Error {
  constructor() {
    super("Neprihlásený");
  }
}

const errorBodySchema = z.object({ error: z.string() });

async function serverErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const parsed = errorBodySchema.safeParse(await response.json());
    if (parsed.success) return parsed.data.error;
  } catch {
    // Telo nie je platný JSON (alebo chýba) — použi všeobecnú hlášku.
  }
  return fallback;
}

async function readJson(response: Response, fallback: string): Promise<unknown> {
  if (response.status === 401) throw new PairingReviewUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function searchPairingReview(input: { readonly filter: PairingReviewFilter; readonly page: number }): Promise<PairingReviewSearchResult> {
  const query = new URLSearchParams({ filter: input.filter, page: String(input.page), pageSize: String(PAGE_SIZE) });
  const response = await fetch(`/api/pairing-review?${query.toString()}`);
  return searchSchema.parse(await readJson(response, "Zoznam párovania sa nepodarilo načítať"));
}

const countSchema = z.object({ total: z.number() });

// Badge v ľavom menu (`App.tsx`, rovnaký priamy vzor ako `restockLinksMissingCount`,
// issue 331) — musí byť známy hneď po prihlásení. Znovupoužíva TEN ISTÝ
// `GET /api/pairing-review` s `filter=unreviewed&pageSize=1` (lacný dopyt,
// `total` sa v `listPairingReview` počíta nad CELOU odfiltrovanou množinou
// nezávisle od `pageSize`). Chyba (401/sieť) sa nikdy nehádže — odznak
// zostane na poslednej známej hodnote.
export async function fetchPairingReviewUnreviewedCount(): Promise<number> {
  const query = new URLSearchParams({ filter: "unreviewed", page: "1", pageSize: "1" });
  const response = await fetch(`/api/pairing-review?${query.toString()}`);
  if (response.status === 401) return 0;
  if (!response.ok) return 0;
  const parsed = countSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.total : 0;
}

const candidateSchema = z.object({
  name: z.string(),
  url: z.string(),
  rawScore: z.number(),
  codeHit: z.boolean(),
});
export type PairingReviewCandidate = z.infer<typeof candidateSchema>;
const candidatesSchema = z.object({ candidates: z.array(candidateSchema) });

// issue 387 E6 — lazy top-8 kandidátov pre rozhodovací panel (design komentár
// na tickete: volané AŽ pri otvorení panelu ✗ Zlé, nikdy vopred).
export async function fetchPairingCandidates(productKey: string): Promise<readonly PairingReviewCandidate[]> {
  const response = await fetch(`/api/pairing-review/${encodeURIComponent(productKey)}/candidates`);
  return candidatesSchema.parse(await readJson(response, "Zoznam kandidátov sa nepodarilo načítať")).candidates;
}

// issue 387 E6 — diskriminovaná únia presne zrkadliaca server (`http/pairing-
// review-routes.ts`'s `pairingDecisionBody`).
export type PairingDecisionAction =
  | { readonly status: "good" }
  | { readonly status: "manual"; readonly url: string }
  | { readonly status: "unavailable" }
  | { readonly status: "discontinued" }
  | { readonly status: "revert" };

export async function sendPairingDecision(productKey: string, action: PairingDecisionAction): Promise<void> {
  const response = await fetch(`/api/pairing-review/${encodeURIComponent(productKey)}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
  await readJson(response, "Uloženie rozhodnutia sa nepodarilo");
}
