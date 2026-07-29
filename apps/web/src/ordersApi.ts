import { z } from "zod";

// Zrkadlí `OrderLineState`/`OpenOrderLine`/`SupplierOpenOrders` z
// `apps/api/src/modules/orders/queries.ts` — vlastná zod schéma namiesto
// zdieľaného typu, rovnaký vzor ako `catalogApi.ts` (frontend a backend sú
// samostatné balíčky, žiadny zdieľaný typový balík medzi nimi (zatiaľ)
// neexistuje).
const orderLineSchema = z.object({
  lineId: z.string(),
  orderId: z.string(),
  externalOrderId: z.string(),
  customerName: z.string(),
  comment: z.string().nullable(),
  placedAt: z.string(),
  variantCode: z.string(),
  variantName: z.string(),
  sizeLabel: z.string().nullable(),
  quantity: z.number(),
  state: z.enum(["objednane", "caka_sa", "skladom", "nedostupne"]),
});

const supplierGroupSchema = z.object({
  supplier: z.string(),
  lines: z.array(orderLineSchema),
});

const openOrdersSchema = z.object({ suppliers: z.array(supplierGroupSchema) });

export type OrderLine = z.infer<typeof orderLineSchema>;
export type SupplierOpenOrders = z.infer<typeof supplierGroupSchema>;

/** Relácia medzitým vypršala (401) — rovnaký vzor ako `CatalogUnauthorizedError`. */
export class OrdersUnauthorizedError extends Error {
  constructor() {
    super("Neprihlásený");
  }
}

async function readJson(response: Response, fallback: string): Promise<unknown> {
  if (response.status === 401) throw new OrdersUnauthorizedError();
  if (!response.ok) throw new Error(fallback);
  return await response.json();
}

export async function fetchOpenOrders(): Promise<readonly SupplierOpenOrders[]> {
  const response = await fetch("/api/orders/open");
  const parsed = openOrdersSchema.parse(
    await readJson(response, "Otvorené objednávky sa nepodarilo načítať"),
  );
  return parsed.suppliers;
}
