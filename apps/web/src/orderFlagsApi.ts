import { z } from "zod";

// issue 290: "Eshop → Výmena tovaru / Vrátený tovar / Reklamácie" — zrkadlí
// `OrderFlagRow`/`ClaimOrderRow`/`OrderFlagCounts`
// (`apps/api/src/modules/orders/order-flags-queries.ts`).

const orderFlagRowSchema = z.object({
  id: z.string(),
  externalOrderId: z.string(),
  customerName: z.string(),
  statusName: z.string(),
  placedAt: z.string(),
  totalPriceWithVat: z.string().nullable(),
  comment: z.string().nullable(),
  adminUrl: z.string(),
  unresolved: z.boolean(),
});
export type OrderFlagRow = z.infer<typeof orderFlagRowSchema>;

const claimOrderRowSchema = orderFlagRowSchema.extend({
  claimNote: z.string().nullable(),
  claimMarkedAt: z.string(),
});
export type ClaimOrderRow = z.infer<typeof claimOrderRowSchema>;

const listSchema = z.object({ orders: z.array(orderFlagRowSchema) });
const claimListSchema = z.object({ orders: z.array(claimOrderRowSchema) });

const countsSchema = z.object({ exchange: z.number(), returned: z.number(), claims: z.number() });
export type OrderFlagCounts = z.infer<typeof countsSchema>;

export class OrderFlagsUnauthorizedError extends Error {
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
  if (response.status === 401) throw new OrderFlagsUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function fetchExchangeOrders(): Promise<readonly OrderFlagRow[]> {
  const response = await fetch("/api/order-flags/exchange");
  return listSchema.parse(await readJson(response, "Zoznam výmen sa nepodarilo načítať")).orders;
}

export async function fetchReturnedOrders(): Promise<readonly OrderFlagRow[]> {
  const response = await fetch("/api/order-flags/returned");
  return listSchema.parse(await readJson(response, "Zoznam vrátení sa nepodarilo načítať")).orders;
}

export async function fetchClaimOrders(): Promise<readonly ClaimOrderRow[]> {
  const response = await fetch("/api/order-flags/claims");
  return claimListSchema.parse(await readJson(response, "Zoznam reklamácií sa nepodaril načítať")).orders;
}

// Rovnaký "tichý fallback na nuly" vzor ako `upozorneniaApi.ts`'s
// `fetchUpozorneniaCount` — odznaky v menu nesmú zhodiť appku pri
// sieťovom výpadku, len ostanú na predchádzajúcej hodnote.
const ZERO_COUNTS: OrderFlagCounts = { exchange: 0, returned: 0, claims: 0 };
export async function fetchOrderFlagCounts(): Promise<OrderFlagCounts> {
  try {
    const response = await fetch("/api/order-flags/counts");
    if (!response.ok) return ZERO_COUNTS;
    return countsSchema.parse(await response.json());
  } catch {
    return ZERO_COUNTS;
  }
}

const markResultSchema = z.union([z.object({ ok: z.literal(true), orderId: z.string() }), z.object({ ok: z.literal(false), error: z.string() })]);
export type MarkClaimResult = z.infer<typeof markResultSchema>;

export async function markOrderClaim(orderCode: string, note: string): Promise<MarkClaimResult> {
  const response = await fetch("/api/order-flags/claims", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderCode, note: note.trim() === "" ? undefined : note.trim() }),
  });
  return markResultSchema.parse(await readJson(response, "Označenie reklamácie zlyhalo"));
}

export async function clearOrderClaim(orderId: string): Promise<void> {
  const response = await fetch(`/api/order-flags/claims/${encodeURIComponent(orderId)}/clear`, { method: "POST" });
  await readJson(response, "Zrušenie reklamácie zlyhalo");
}
