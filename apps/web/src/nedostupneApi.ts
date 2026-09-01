import { z } from "zod";

// issue 176: "Nedostupné tovary" — zrkadlí `NedostupneGroup`/`NedostupneOrderRow`
// (`apps/api/src/modules/nedostupne/queries.ts`).

// issue 238: majiteľove RUČNE vložené odkazy náhrad (nahrádza pôvodný
// automatický `product.relatedCodes` návrh — appka k odkazu nepozná meno).
const replacementLinkSchema = z.object({ id: z.string(), url: z.string() });
export type ReplacementLink = z.infer<typeof replacementLinkSchema>;

const orderRowSchema = z.object({
  orderCode: z.string(),
  // issue 529: interné id objednávky — vstup poznámky ho posiela do
  // `updateOrderComment` (`PUT /api/orders/:id/comment`), tá istá zapisovacia
  // cesta ako stĺpec POZNÁMKY v „Na objednanie".
  orderId: z.string(),
  adminLink: z.string(),
  customerName: z.string(),
  email: z.string(),
  quantity: z.number(),
  placedAt: z.string(),
  nedostupneSent: z.boolean(),
  alternativaSent: z.boolean(),
  // issue 529: aktuálna poznámka objednávky (`order.comment`) — predvyplní vstup.
  comment: z.string().nullable(),
});

const groupSchema = z.object({
  variantCode: z.string(),
  itemName: z.string(),
  sizeLabel: z.string().nullable(),
  // issue 238: `null` = adresu/odkaz appka nemá — meno/kód ZOSTÁVA
  // NEAKTÍVNY (nikdy vyhľadávací fallback).
  ourProductUrl: z.string().nullable(),
  supplierUrl: z.string().nullable(),
  replacementLinks: z.array(replacementLinkSchema),
  orders: z.array(orderRowSchema),
});
export type NedostupneGroup = z.infer<typeof groupSchema>;
export type NedostupneOrderRow = z.infer<typeof orderRowSchema>;

const listSchema = z.object({ groups: z.array(groupSchema), bccMissing: z.boolean(), mailNotConfigured: z.boolean() });
export type NedostupneList = z.infer<typeof listSchema>;

export type NedostupneEmailType = "nedostupne" | "alternativa";

const previewResultSchema = z.union([
  // issue 277: `text` je plain-textová verzia (rovnaká, akú appka odošle ako
  // fallback) — frontend ju predvyplní do editovateľného okna náhľadu.
  z.object({ ok: z.literal(true), subject: z.string(), html: z.string(), text: z.string(), recipient: z.string(), customerName: z.string(), previewToken: z.string() }),
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
  // issue 277: text, ktorý obsluha (prípadne) upravila v okne náhľadu —
  // appka ho pošle PRESNE takto, nikdy znova vygenerovanú šablónu.
  editedBody: string,
): Promise<NedostupneSendResult> {
  const response = await fetch("/api/nedostupne/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderCode, variantCode, emailType, previewToken, editedBody }),
  });
  if (response.status === 401) throw new NedostupneUnauthorizedError();
  return sendResultSchema.parse(await response.json());
}

// issue 238: majiteľove RUČNE vložené odkazy náhrad — pridanie/zmazanie.
const addReplacementLinkResultSchema = z.object({ ok: z.literal(true), link: replacementLinkSchema });

export async function addReplacementLink(variantCode: string, url: string): Promise<ReplacementLink> {
  const response = await fetch("/api/nedostupne/replacement-links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ variantCode, url }),
  });
  if (response.status === 401) throw new NedostupneUnauthorizedError();
  return addReplacementLinkResultSchema.parse(await readJson(response, "Odkaz sa nepodarilo pridať")).link;
}

export async function removeReplacementLink(id: string): Promise<void> {
  const response = await fetch(`/api/nedostupne/replacement-links/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (response.status === 401) throw new NedostupneUnauthorizedError();
  await readJson(response, "Odkaz sa nepodarilo zmazať");
}
