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
const ingestSchema = z.object({ status: z.string() });

export type CatalogStats = z.infer<typeof statsSchema>;
export type CatalogSnapshot = z.infer<typeof snapshotSchema>;
export type VariantSummary = z.infer<typeof variantSchema>;

export const PAGE_SIZE = 50;

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("Katalóg sa nepodarilo načítať");
  return await response.json();
}

export async function fetchCatalogStats(): Promise<CatalogStats> {
  return statsSchema.parse(await readJson(await fetch("/api/catalog/stats")));
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
  return searchSchema.parse(await readJson(await fetch(`/api/catalog/variants?${query.toString()}`)));
}

export async function triggerCatalogIngest(): Promise<z.infer<typeof ingestSchema>> {
  const response = await fetch("/api/catalog/ingest", { method: "POST" });
  if (!response.ok) throw new Error("Import sa nepodarilo spustiť");
  return ingestSchema.parse(await response.json());
}
