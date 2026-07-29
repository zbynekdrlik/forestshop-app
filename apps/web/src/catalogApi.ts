import { z } from "zod";

export type CatalogState = "all" | "sellable" | "out_of_stock" | "discontinued";

const snapshotSchema = z.object({
  id: z.string(),
  fetchedAt: z.string(),
  sourceLabel: z.string(),
  verdict: z.enum(["accepted", "rejected"]),
  rejectionReason: z.string().nullable(),
  rowCount: z.number(),
  byteSize: z.number(),
  columnCount: z.number(),
  variantCount: z.number().nullable(),
  productCount: z.number().nullable(),
  issueCount: z.number().nullable(),
});

const statsSchema = z.object({
  variantCount: z.number(),
  productCount: z.number(),
  sellable: z.number(),
  outOfStock: z.number(),
  discontinued: z.number(),
  missing: z.number(),
  lastSnapshot: snapshotSchema.nullable(),
});

const variantSchema = z.object({
  code: z.string(),
  productKey: z.string(),
  sizeLabel: z.string().nullable(),
  name: z.string(),
  state: z.enum(["sellable", "out_of_stock", "discontinued"]),
  stock: z.number(),
  price: z.string().nullable(),
  currency: z.string().nullable(),
  availabilityText: z.string(),
  missingSince: z.string().nullable(),
});

const searchSchema = z.object({ total: z.number(), items: z.array(variantSchema) });

// Zrkadlí `CatalogIngestResult` z `apps/api/src/modules/catalog/ingest.ts` —
// vrátane "busy" (súbežný import už beží, pridáva sa paralelne v Task 6).
// Rozlíšená únia namiesto holého `{ status: string }`, aby stránka vedela pre
// každý výsledok zobraziť vlastnú slovenskú hlášku namiesto ticho zahodených detailov.
const ingestOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    snapshotId: z.string(),
    variantCount: z.number(),
    productCount: z.number(),
    missingCount: z.number(),
    issueCount: z.number(),
  }),
  z.object({
    status: z.literal("rejected"),
    snapshotId: z.string(),
    reason: z.string(),
  }),
  z.object({
    status: z.literal("duplicate"),
    snapshotId: z.string(),
  }),
  z.object({
    status: z.literal("busy"),
  }),
]);

export type CatalogStats = z.infer<typeof statsSchema>;
export type VariantSummary = z.infer<typeof variantSchema>;
export type CatalogIngestOutcome = z.infer<typeof ingestOutcomeSchema>;

export const PAGE_SIZE = 50;

/**
 * Relácia medzitým vypršala (401) — odlíšené od bežnej chyby, aby volajúci
 * mohol vynútiť opätovné prihlásenie namiesto všeobecnej hlášky "nepodarilo
 * sa načítať", ktorá by nechala používateľa na mŕtvom dashboarde.
 */
export class CatalogUnauthorizedError extends Error {
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
  if (response.status === 401) throw new CatalogUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function fetchCatalogStats(): Promise<CatalogStats> {
  const response = await fetch("/api/catalog/stats");
  return statsSchema.parse(await readJson(response, "Katalóg sa nepodarilo načítať"));
}

export async function searchCatalogVariants(input: {
  readonly q: string;
  readonly state: CatalogState;
  readonly page: number;
}): Promise<z.infer<typeof searchSchema>> {
  const query = new URLSearchParams({
    q: input.q,
    state: input.state,
    page: String(input.page),
    pageSize: String(PAGE_SIZE),
  });
  const response = await fetch(`/api/catalog/variants?${query.toString()}`);
  return searchSchema.parse(await readJson(response, "Katalóg sa nepodarilo načítať"));
}

export async function triggerCatalogIngest(): Promise<CatalogIngestOutcome> {
  const response = await fetch("/api/catalog/ingest", { method: "POST" });
  return ingestOutcomeSchema.parse(await readJson(response, "Import sa nepodarilo spustiť"));
}
