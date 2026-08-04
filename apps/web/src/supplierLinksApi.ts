import { z } from "zod";

// issue 239: "Eshop → Párovanie produktov" — zrkadlí
// `GET/POST /api/product-links(...)` (`apps/api/src/http/product-links-routes.ts`).
// Vlastná zod schéma namiesto zdieľaného typu, rovnaký vzor ako `pairingApi.ts`/
// `ordersApi.ts` (frontend a backend sú samostatné balíčky).
export type ProductLinkState = "all" | "missing" | "linked";

const itemSchema = z.object({
  productKey: z.string(),
  productName: z.string(),
  supplier: z.string().nullable(),
  variantCount: z.number(),
  url: z.string().nullable(),
  updatedAt: z.string().nullable(),
  syncedAt: z.string().nullable(),
});
export type ProductLinkItem = z.infer<typeof itemSchema>;

const searchSchema = z.object({ total: z.number(), missingTotal: z.number(), items: z.array(itemSchema) });

export const PAGE_SIZE = 50;

/** Relácia medzitým vypršala (401) — rovnaký vzor ako `PairingUnauthorizedError`. */
export class SupplierLinksUnauthorizedError extends Error {
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
  if (response.status === 401) throw new SupplierLinksUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function searchProductLinks(input: {
  readonly q: string;
  readonly state: ProductLinkState;
  readonly page: number;
}): Promise<z.infer<typeof searchSchema>> {
  const query = new URLSearchParams({
    q: input.q,
    state: input.state,
    page: String(input.page),
    pageSize: String(PAGE_SIZE),
  });
  const response = await fetch(`/api/product-links?${query.toString()}`);
  return searchSchema.parse(await readJson(response, "Zoznam produktov sa nepodarilo načítať"));
}

export async function saveProductLink(productKey: string, url: string): Promise<void> {
  const response = await fetch(`/api/product-links/${encodeURIComponent(productKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  await readJson(response, "Uloženie odkazu na dodávateľa sa nepodarilo");
}
