import { z } from "zod";

// issue 292: "Eshop → Preprava DPD" — zrkadlí `apps/api/src/http/dpd-routes.ts`.
export class DpdUnauthorizedError extends Error {
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
  if (response.status === 401) throw new DpdUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

const previewSchema = z.object({
  orderId: z.string(),
  externalOrderId: z.string(),
  recipientName: z.string(),
  recipientCompany: z.string().nullable(),
  recipientPhone: z.string().nullable(),
  street: z.string().nullable(),
  houseNumber: z.string().nullable(),
  city: z.string().nullable(),
  zip: z.string().nullable(),
  countryName: z.string().nullable(),
  addressComplete: z.boolean(),
  weightKg: z.string(),
  isCod: z.boolean(),
  codAmount: z.string().nullable(),
});
export type DpdShipmentPreview = z.infer<typeof previewSchema>;

const shippableOrderSchema = z.object({
  placedAt: z.string(),
  preview: previewSchema,
  lastFailure: z.string().nullable(),
});
export type DpdShippableOrder = z.infer<typeof shippableOrderSchema>;

const ordersSchema = z.object({ configured: z.boolean(), orders: z.array(shippableOrderSchema) });

export async function fetchDpdShippableOrders(): Promise<z.infer<typeof ordersSchema>> {
  const response = await fetch("/api/dpd/orders");
  return ordersSchema.parse(await readJson(response, "Zoznam objednávok na odoslanie sa nepodarilo načítať"));
}

// issue 445: počet objednávok na objednanie DPD — nav badge (rovnaký vzor
// ako `upozorneniaApi.ts`'s `fetchUpozorneniaCount`: pri 401/chybe vráti 0,
// odznak zostane na poslednej známej hodnote namiesto pádu).
const countSchema = z.object({ count: z.number() });

export async function fetchDpdShippableCount(): Promise<number> {
  const response = await fetch("/api/dpd/orders/count");
  if (response.status === 401) return 0;
  if (!response.ok) return 0;
  return countSchema.parse(await response.json()).count;
}

const previewsSchema = z.object({ previews: z.array(previewSchema) });

export async function fetchDpdPreview(orderIds: readonly string[], weightOverrides: Readonly<Record<string, string>>): Promise<readonly DpdShipmentPreview[]> {
  const response = await fetch("/api/dpd/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderIds, weightOverrides }),
  });
  return previewsSchema.parse(await readJson(response, "Náhľad sa nepodarilo vypočítať")).previews;
}

const shipmentResultSchema = z.object({
  orderId: z.string(),
  ok: z.boolean(),
  parcelNumber: z.string().optional(),
  error: z.string().optional(),
});
export type DpdShipmentResult = z.infer<typeof shipmentResultSchema>;
const shipmentResultsSchema = z.object({ results: z.array(shipmentResultSchema) });

export async function sendDpdShipments(
  orderIds: readonly string[],
  weightOverrides: Readonly<Record<string, string>>,
): Promise<readonly DpdShipmentResult[]> {
  const response = await fetch("/api/dpd/shipments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderIds, weightOverrides }),
  });
  if (response.status === 401) throw new DpdUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, "Odoslanie zásielok zlyhalo"));
  return shipmentResultsSchema.parse(await response.json()).results;
}

export async function requestDpdPickup(pickupDate: string): Promise<{ readonly ok: boolean; readonly error: string | null }> {
  const response = await fetch("/api/dpd/pickup-orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pickupDate }),
  });
  if (response.status === 401) throw new DpdUnauthorizedError();
  const body = z.object({ ok: z.boolean(), error: z.string().nullable() }).parse(await response.json());
  return body;
}
