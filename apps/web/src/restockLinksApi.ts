import { z } from "zod";

// issue 311: "Vypredané → Skladom: návrhy odkazov" — zrkadlí
// `GET /api/restock-links` (`apps/api/src/http/restock-links-routes.ts`).
// Zápis potvrdeného odkazu ide cez UŽ existujúcu `saveProductLink`
// (`supplierLinksApi.ts`, #239) — táto obrazovka ju len znovupoužije,
// žiadna nová zapisovacia funkcia tu.
const candidateSchema = z.object({
  productKey: z.string(),
  productName: z.string(),
  supplier: z.string().nullable(),
  url: z.string(),
});
export type RestockLinkCandidate = z.infer<typeof candidateSchema>;

const itemSchema = z.object({
  productKey: z.string(),
  productName: z.string(),
  supplier: z.string().nullable(),
  candidates: z.array(candidateSchema),
});
export type RestockLinkMissingItem = z.infer<typeof itemSchema>;

const searchSchema = z.object({ total: z.number(), items: z.array(itemSchema) });

export const PAGE_SIZE = 50;

/** Relácia medzitým vypršala (401) — rovnaký vzor ako `SupplierLinksUnauthorizedError`. */
export class RestockLinksUnauthorizedError extends Error {
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
  if (response.status === 401) throw new RestockLinksUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function searchRestockLinkSuggestions(input: {
  readonly q: string;
  readonly page: number;
}): Promise<z.infer<typeof searchSchema>> {
  const query = new URLSearchParams({ q: input.q, page: String(input.page), pageSize: String(PAGE_SIZE) });
  const response = await fetch(`/api/restock-links?${query.toString()}`);
  return searchSchema.parse(await readJson(response, "Zoznam vypredaných produktov bez linky sa nepodarilo načítať"));
}
