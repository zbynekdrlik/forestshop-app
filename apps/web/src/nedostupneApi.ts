import { z } from "zod";

// issue 176: "Nedostupné tovary" — zrkadlí `NedostupneGroup`/`NedostupneOrderRow`
// (`apps/api/src/modules/nedostupne/queries.ts`).

const alternativeSchema = z.object({ code: z.string(), name: z.string(), url: z.string() });

const orderRowSchema = z.object({
  orderCode: z.string(),
  adminLink: z.string(),
  customerName: z.string(),
  email: z.string(),
  quantity: z.number(),
  placedAt: z.string(),
  nedostupneSent: z.boolean(),
  alternativaSent: z.boolean(),
});

const groupSchema = z.object({
  variantCode: z.string(),
  itemName: z.string(),
  sizeLabel: z.string().nullable(),
  alternatives: z.array(alternativeSchema),
  orders: z.array(orderRowSchema),
});
export type NedostupneGroup = z.infer<typeof groupSchema>;
export type NedostupneOrderRow = z.infer<typeof orderRowSchema>;

const listSchema = z.object({ groups: z.array(groupSchema), bccMissing: z.boolean(), mailNotConfigured: z.boolean() });
export type NedostupneList = z.infer<typeof listSchema>;

export type NedostupneEmailType = "nedostupne" | "alternativa";

const previewResultSchema = z.union([
  z.object({ ok: z.literal(true), subject: z.string(), html: z.string(), recipient: z.string(), customerName: z.string(), previewToken: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type NedostupnePreview = Extract<z.infer<typeof previewResultSchema>, { readonly ok: true }>;

const sendResultSchema = z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), error: z.string() })]);
export type NedostupneSendResult = z.infer<typeof sendResultSchema>;

export class NedostupneUnauthorizedError extends Error {
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
  if (response.status === 401) throw new NedostupneUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function fetchNedostupneList(): Promise<NedostupneList> {
  const response = await fetch("/api/nedostupne");
  return listSchema.parse(await readJson(response, "Nedostupné tovary sa nepodarilo načítať"));
}

export async function fetchNedostupnePreview(orderCode: string, variantCode: string, emailType: NedostupneEmailType): Promise<NedostupnePreview> {
  const response = await fetch("/api/nedostupne/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderCode, variantCode, emailType }),
  });
  const parsed = previewResultSchema.parse(await readJson(response, "Náhľad sa nepodarilo načítať"));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed;
}

// issue 176 (code review pred mergom, PR #182): server VYŽADUJE `previewToken`
// vydaný `/preview` PRE PRESNE tento (orderCode, variantCode, emailType) —
// server-side vynútenie povinného náhľadu (`preview-tokens.ts`). Volajúci
// (`NedostupneSection.tsx`) preto musí odoslať TEN ISTÝ token, aký dostal z
// `fetchNedostupnePreview`, nikdy vlastný/vymyslený reťazec.
export async function sendNedostupneEmail(
  orderCode: string,
  variantCode: string,
  emailType: NedostupneEmailType,
  previewToken: string,
): Promise<NedostupneSendResult> {
  const response = await fetch("/api/nedostupne/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderCode, variantCode, emailType, previewToken }),
  });
  if (response.status === 401) throw new NedostupneUnauthorizedError();
  return sendResultSchema.parse(await response.json());
}
