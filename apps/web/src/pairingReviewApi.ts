import { z } from "zod";

// issue 387 E5: "Eshop → Párovanie" — zrkadlí `GET /api/pairing-review`
// (`apps/api/src/http/pairing-review-routes.ts`). issue 387 E6 pridáva
// rozhodnutia: `sendPairingDecision`/`fetchPairingCandidates` + `decision`
// pole v položke.

export const PAIRING_REVIEW_FILTERS = ["unreviewed", "matched", "unmatched", "st1", "st2", "st3", "decided", "terminal", "all"] as const;
export type PairingReviewFilter = (typeof PAIRING_REVIEW_FILTERS)[number];

const chosenCandidateSchema = z.object({
  name: z.string(),
  url: z.string(),
  // issue 397 — obrázok kandidáta (adaptér, alebo `og:image` fallback).
  imageUrl: z.string().nullable(),
  rawScore: z.number(),
  codeHit: z.boolean(),
});

// issue 399 — `split`: produkt rozdelený na per-veľkosť linky (žiadna `url`
// na TOMTO stĺpci, presne ako `unavailable`/`discontinued`).
export const PAIRING_DECISION_STATUSES = ["good", "manual", "unavailable", "discontinued", "split"] as const;
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
  // issue 422 — "naša strana": pôvodná (pred zľavou) cena, súčet zásoby,
  // dostupnostný text (persistované, žiadny live-fetch).
  standardPriceMin: z.string().nullable(),
  standardPriceMax: z.string().nullable(),
  stockTotal: z.number(),
  availabilityText: z.string().nullable(),
  ourUrl: z.string(),
  ourUrlIsSearchFallback: z.boolean(),
  ourImageUrl: z.string().nullable(),
  hasEffectiveLink: z.boolean(),
  // issue 401 — `true` = dodávateľ MÁ automatický adaptér (WETLAND/BETALOV/ODIMON).
  supplierHasAdapter: z.boolean(),
  // issue 401 — `null` keď produkt ešte nikdy nebol gatherovaný.
  gatheredAt: z.string().nullable(),
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
  // issue 432 — skutočné katalógové pokrytie linkami (menovateľ = aktívne
  // produkty s aspoň jedným predajným variantom, čitateľ = z nich s efektívnou
  // linkou), na rozdiel od `gatheredTotal`/`linkedTotal` (veľkosť recenznej fronty).
  catalogLinked: z.number(),
  catalogActive: z.number(),
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
  // issue 409 — obrázok kandidáta, `null` keď žiadny zdroj neposkytol použiteľný.
  imageUrl: z.string().nullable(),
  rawScore: z.number(),
  codeHit: z.boolean(),
});
export type PairingReviewCandidate = z.infer<typeof candidateSchema>;
const candidatesSchema = z.object({ candidates: z.array(candidateSchema) });

// issue 387 E6 — lazy top-8 kandidátov pre rozhodovací panel (design komentár
// na tickete: volané AŽ pri otvorení panelu „vyber url"/„✗ Zmeniť", nikdy vopred).
export async function fetchPairingCandidates(productKey: string): Promise<readonly PairingReviewCandidate[]> {
  const response = await fetch(`/api/pairing-review/${encodeURIComponent(productKey)}/candidates`);
  return candidatesSchema.parse(await readJson(response, "Zoznam kandidátov sa nepodarilo načítať")).candidates;
}

// issue 387 E6 — diskriminovaná únia presne zrkadliaca server (`http/pairing-
// review-routes.ts`'s `pairingDecisionBody`). issue 399 — `split` pridané.
export type PairingDecisionAction =
  | { readonly status: "good" }
  | { readonly status: "manual"; readonly url: string }
  | { readonly status: "unavailable" }
  | { readonly status: "discontinued" }
  | { readonly status: "split" }
  | { readonly status: "revert" };

export async function sendPairingDecision(productKey: string, action: PairingDecisionAction): Promise<void> {
  const response = await fetch(`/api/pairing-review/${encodeURIComponent(productKey)}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
  await readJson(response, "Uloženie rozhodnutia sa nepodarilo");
}

// issue 399 — "Hľadať / opraviť": jedna karta pre AKÝKOĽVEK produkt, `null`
// = neznámy `productKey` (404 sa NIKDY nehádže — volajúci to rieši ako
// "nenájdené", nie ako sieťovú/serverovú chybu).
export async function fetchPairingReviewItem(productKey: string): Promise<PairingReviewItem | null> {
  const response = await fetch(`/api/pairing-review/${encodeURIComponent(productKey)}`);
  if (response.status === 401) throw new PairingReviewUnauthorizedError();
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await serverErrorMessage(response, "Produkt sa nepodarilo načítať"));
  const itemSchemaWrap = z.object({ item: itemSchema });
  return itemSchemaWrap.parse(await response.json()).item;
}

// issue 399 — "✂ Rozdeliť na veľkosti": zoznam variantov produktu s ich
// AKTUÁLNYM per-veľkosť linkom.
const variantLinkSchema = z.object({ code: z.string(), sizeLabel: z.string().nullable(), url: z.string().nullable() });
export type PairingVariantLink = z.infer<typeof variantLinkSchema>;
const variantLinksSchema = z.object({ variants: z.array(variantLinkSchema) });

export async function fetchPairingVariantLinks(productKey: string): Promise<readonly PairingVariantLink[]> {
  const response = await fetch(`/api/pairing-review/${encodeURIComponent(productKey)}/variants`);
  return variantLinksSchema.parse(await readJson(response, "Zoznam veľkostí sa nepodarilo načítať")).variants;
}

// `url: null`/`""` vymaže per-veľkosť link (server ich rieši rovnako).
export async function savePairingVariantLink(productKey: string, code: string, url: string | null): Promise<void> {
  const response = await fetch(`/api/pairing-review/${encodeURIComponent(productKey)}/variant-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, url }),
  });
  await readJson(response, "Uloženie linku sa nepodarilo");
}

// issue 422 — "Živé ceny/dostupnosť" dodávateľa (lazy, na viditeľnosť karty/
// otvorenie panelu). `null`/`null` = žiadne info (neznáma doména, sieťová
// chyba, alebo ešte nenačítané) — TICHO, NIKDY sa nehádže: quiet-failure
// požiadavka ticketu (žiadna konzolová chyba pri zlyhanom/neexistujúcom
// live-info).
const liveSupplierInfoSchema = z.object({ price: z.string().nullable(), availabilityText: z.string().nullable() });
export type LiveSupplierInfo = z.infer<typeof liveSupplierInfoSchema>;
export const EMPTY_LIVE_SUPPLIER_INFO: LiveSupplierInfo = { price: null, availabilityText: null };

export async function fetchLiveSupplierInfo(url: string): Promise<LiveSupplierInfo> {
  try {
    const response = await fetch(`/api/pairing-review/live-supplier-info?url=${encodeURIComponent(url)}`);
    if (!response.ok) return EMPTY_LIVE_SUPPLIER_INFO;
    const parsed = liveSupplierInfoSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : EMPTY_LIVE_SUPPLIER_INFO;
  } catch {
    return EMPTY_LIVE_SUPPLIER_INFO;
  }
}
