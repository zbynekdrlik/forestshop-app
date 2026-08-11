import { z } from "zod";

// issue 345: "Eshop → Objednávky predajňa" — zrkadlí `GET /api/floor-orders`
// (`apps/api/src/http/floor-orders-routes.ts`). LEN čítanie, žiadna
// zapisovacia funkcia v tomto súbore.

const floorOrderRowSchema = z.object({
  id: z.string(),
  externalOrderId: z.string(),
  customerName: z.string(),
  statusName: z.string(),
  placedAt: z.string(),
  totalPriceWithVat: z.string().nullable(),
  adminUrl: z.string(),
});
export type FloorOrderRow = z.infer<typeof floorOrderRowSchema>;

const searchSchema = z.object({ total: z.number(), items: z.array(floorOrderRowSchema) });

// Zámerne malé (nie 50 ako `restock-links`/katalóg) — produkcia má dnes len
// ~30 zodpovedajúcich objednávok, malá strana robí "Načítať ďalšie" reálne
// overiteľné aj naživo na skutočných dátach (rozhodnuté na tickete).
export const PAGE_SIZE = 10;

/** Relácia medzitým vypršala (401) — rovnaký vzor ako ostatné `*ApiError` triedy. */
export class FloorOrdersUnauthorizedError extends Error {
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
    // telo nie je platný JSON — použi všeobecnú hlášku
  }
  return fallback;
}

async function readJson(response: Response, fallback: string): Promise<unknown> {
  if (response.status === 401) throw new FloorOrdersUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function fetchFloorOrders(input: { readonly page: number }): Promise<z.infer<typeof searchSchema>> {
  const query = new URLSearchParams({ page: String(input.page), pageSize: String(PAGE_SIZE) });
  const response = await fetch(`/api/floor-orders?${query.toString()}`);
  return searchSchema.parse(await readJson(response, "Zoznam objednávok predajne sa nepodarilo načítať"));
}
