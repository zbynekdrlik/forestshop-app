import { z } from "zod";

// issue 240: "Eshop → Vyhľadať" — zrkadlí `GET /api/search`
// (`apps/api/src/modules/search/queries.ts`) a `GET /api/product-detail/:productKey`
// (`apps/api/src/modules/product-detail/queries.ts`). Vlastná zod schéma
// namiesto zdieľaného typu, rovnaký vzor ako `catalogApi.ts`/`supplierLinksApi.ts`.

const productHitSchema = z.object({
  productKey: z.string(),
  variantCode: z.string(),
  productName: z.string(),
  sizeLabel: z.string().nullable(),
  supplier: z.string().nullable(),
  externalCode: z.string().nullable(),
  state: z.enum(["sellable", "out_of_stock", "discontinued"]),
});
export type ProductSearchHit = z.infer<typeof productHitSchema>;

const orderHitSchema = z.object({
  orderId: z.string(),
  externalOrderId: z.string(),
  customerName: z.string(),
  email: z.string().nullable(),
  statusName: z.string(),
  placedAt: z.string(),
  // Rovnaká druhá vrstva overenia ako `ordersApi.ts`'s `adminUrl` — `href`
  // bezpečnosť by nemala závisieť LEN od backendovho zloženia URL.
  adminUrl: z.string().regex(/^https?:\/\//),
});
export type OrderSearchHit = z.infer<typeof orderHitSchema>;

const searchResultSchema = z.object({
  products: z.array(productHitSchema),
  orders: z.array(orderHitSchema),
});
export type GlobalSearchResult = z.infer<typeof searchResultSchema>;

const variantDetailSchema = z.object({
  code: z.string(),
  sizeLabel: z.string().nullable(),
  name: z.string(),
  state: z.enum(["sellable", "out_of_stock", "discontinued"]),
  stock: z.number(),
  price: z.string().nullable(),
  currency: z.string().nullable(),
  availabilityText: z.string(),
  productVisibility: z.string(),
  externalCode: z.string().nullable(),
  missingSince: z.string().nullable(),
  ourShopUrl: z.string().nullable(),
  supplierAvailability: z.enum(["available", "unavailable", "unknown"]).nullable(),
  supplierAvailabilityText: z.string().nullable(),
});
export type ProductDetailVariant = z.infer<typeof variantDetailSchema>;

const productDetailSchema = z.object({
  productKey: z.string(),
  productName: z.string(),
  supplier: z.string().nullable(),
  supplierLinkUrl: z.string().nullable(),
  supplierLinkUpdatedAt: z.string().nullable(),
  supplierLinkSyncedAt: z.string().nullable(),
  variants: z.array(variantDetailSchema),
});
export type ProductDetail = z.infer<typeof productDetailSchema>;

/** Relácia medzitým vypršala (401) — rovnaký vzor ako ostatné `*UnauthorizedError`. */
export class SearchUnauthorizedError extends Error {
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
  if (response.status === 401) throw new SearchUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function globalSearch(q: string): Promise<GlobalSearchResult> {
  const query = new URLSearchParams({ q });
  const response = await fetch(`/api/search?${query.toString()}`);
  return searchResultSchema.parse(await readJson(response, "Vyhľadávanie zlyhalo — server neodpovedal"));
}

export async function fetchProductDetail(productKey: string): Promise<ProductDetail | null> {
  const response = await fetch(`/api/product-detail/${encodeURIComponent(productKey)}`);
  if (response.status === 404) return null;
  return productDetailSchema.parse(await readJson(response, "Detail produktu sa nepodarilo načítať"));
}
