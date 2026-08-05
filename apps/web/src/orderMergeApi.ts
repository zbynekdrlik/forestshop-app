import { z } from "zod";

// issue 257: "Zlúčenie objednávok" — zrkadlí `apps/api/src/http/order-merge-routes.ts`.
// Rovnaký tvar ako `nedostupneApi.ts`.

const candidateOrderSchema = z.object({ orderId: z.string(), externalOrderId: z.string(), placedAt: z.string() });
export type MergeCandidateOrder = z.infer<typeof candidateOrderSchema>;

const groupSchema = z.object({
  customerName: z.string(),
  email: z.string().nullable(),
  orders: z.array(candidateOrderSchema),
});
export type MergeCandidateGroup = z.infer<typeof groupSchema>;

const listSchema = z.object({ groups: z.array(groupSchema), bccMissing: z.boolean(), mailNotConfigured: z.boolean() });
export type OrderMergeList = z.infer<typeof listSchema>;

const previewResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    subject: z.string(),
    html: z.string(),
    // issue 277: plain-textová verzia — frontend ju predvyplní do
    // editovateľného okna náhľadu.
    text: z.string(),
    recipient: z.string(),
    customerName: z.string(),
    orderNumbers: z.array(z.string()),
    previewToken: z.string(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type OrderMergePreview = Extract<z.infer<typeof previewResultSchema>, { readonly ok: true }>;

const sendResultSchema = z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), error: z.string() })]);
export type OrderMergeSendResult = z.infer<typeof sendResultSchema>;

export class OrderMergeUnauthorizedError extends Error {
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
  if (response.status === 401) throw new OrderMergeUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function fetchOrderMergeCandidates(): Promise<OrderMergeList> {
  const response = await fetch("/api/order-merge/candidates");
  return listSchema.parse(await readJson(response, "Zoznam sa nepodarilo načítať"));
}

export async function fetchOrderMergePreview(baseOrderId: string, otherOrderIds: readonly string[]): Promise<OrderMergePreview> {
  const response = await fetch("/api/order-merge/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseOrderId, otherOrderIds }),
  });
  const parsed = previewResultSchema.parse(await readJson(response, "Náhľad sa nepodarilo načítať"));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed;
}

// Server VYŽADUJE `previewToken` vydaný `/preview` PRE PRESNE tento
// (baseOrderId, výber) — server-side vynútenie povinného náhľadu
// (`merge-mail-preview-tokens.ts`). Volajúci preto musí odoslať TEN ISTÝ
// token, aký dostal z `fetchOrderMergePreview`.
export async function sendOrderMergeMail(
  baseOrderId: string,
  otherOrderIds: readonly string[],
  previewToken: string,
  // issue 277: text, ktorý obsluha (prípadne) upravila v okne náhľadu.
  editedBody: string,
): Promise<OrderMergeSendResult> {
  const response = await fetch("/api/order-merge/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseOrderId, otherOrderIds, previewToken, editedBody }),
  });
  if (response.status === 401) throw new OrderMergeUnauthorizedError();
  return sendResultSchema.parse(await response.json());
}
