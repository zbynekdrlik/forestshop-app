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
  // issue 67: odkaz na tovar u dodávateľa (`supplierUrl`, `null` keď v
  // exporte nie je odkaz) + surový text pre plain-text fallback
  // (`supplierNote`) + kód tovaru u dodávateľa (`externalCode`).
  supplierUrl: z.string().nullable(),
  supplierNote: z.string().nullable(),
  externalCode: z.string().nullable(),
});

// Zrkadlí `OrdersIngestResult` z `apps/api/src/modules/orders/ingest.ts` —
// rovnaký vzor ako katalógov `ingestOutcomeSchema` (`catalogApi.ts`). Na
// rozdiel od katalógu tu nie je "duplicate" verdikt (objednávky sa
// neidentifikujú cez sha256 obsahu exportu) — len "accepted"/"rejected".
const ordersIngestOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    orderCount: z.number(),
    lineCount: z.number(),
    skippedItemCount: z.number(),
    pseudoItemCount: z.number(),
    issueCount: z.number(),
  }),
  z.object({
    status: z.literal("rejected"),
    reason: z.string(),
  }),
  // Súbežný import už beží (`ingestInFlight` guard v `orders-routes.ts`) —
  // rovnaký tvar ako katalógov "busy", server ho vracia priamo, bez `rawPath`.
  z.object({
    status: z.literal("busy"),
  }),
]);

export type OrdersIngestOutcome = z.infer<typeof ordersIngestOutcomeSchema>;

const supplierGroupSchema = z.object({
  supplier: z.string(),
  lines: z.array(orderLineSchema),
  // E-mailový kontakt dodávateľa (#31), `null` keď zatiaľ nenastavený.
  email: z.string().nullable(),
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

const errorBodySchema = z.object({ error: z.string() });

// Rovnaký vzor ako `catalogApi.ts`'s `serverErrorMessage` — server posiela
// `{error: "..."}` telo so slovenskou hláškou (napr. neznámy riadok, neplatný
// stav), ktorú treba zobraziť namiesto všeobecného fallbacku.
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
  if (response.status === 401) throw new OrdersUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

// #57: ručné tlačidlo "stiahnuť teraz" na obrazovke Sync zo Shoptetu — volá
// EXISTUJÚCI `POST /api/orders/ingest` (F3, #23), doteraz z webu vôbec
// nedosiahnuteľný (žiadny frontendový wrapper naň neexistoval).
export async function triggerOrdersIngest(): Promise<OrdersIngestOutcome> {
  const response = await fetch("/api/orders/ingest", { method: "POST" });
  return ordersIngestOutcomeSchema.parse(await readJson(response, "Import objednávok sa nepodarilo spustiť"));
}

export async function fetchOpenOrders(): Promise<readonly SupplierOpenOrders[]> {
  const response = await fetch("/api/orders/open");
  const parsed = openOrdersSchema.parse(
    await readJson(response, "Otvorené objednávky sa nepodarilo načítať"),
  );
  return parsed.suppliers;
}

// #25: zmena stavu riadku objednávky — `lineId` je globálne unikátne (UUID
// primárny kľúč `order_line.id`), netreba aj `orderId`.
export async function updateOrderLineState(
  lineId: string,
  state: OrderLine["state"],
): Promise<void> {
  const response = await fetch(`/api/orders/lines/${lineId}/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state }),
  });
  await readJson(response, "Zmena stavu sa nepodarila");
}

// #31: e-mailový kontakt dodávateľa + odoslanie objednávky mailom.
export async function setSupplierEmail(supplier: string, email: string | null): Promise<void> {
  const response = await fetch(`/api/suppliers/${encodeURIComponent(supplier)}/email`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: email ?? "" }),
  });
  await readJson(response, "Nastavenie e-mailu sa nepodarilo");
}

const orderMailPreviewSchema = z.object({
  supplier: z.string(),
  to: z.string().nullable(),
  subject: z.string(),
  body: z.string(),
  itemCount: z.number(),
});

export type OrderMailPreview = z.infer<typeof orderMailPreviewSchema>;

export async function fetchSupplierOrderMailPreview(supplier: string): Promise<OrderMailPreview> {
  const response = await fetch(`/api/suppliers/${encodeURIComponent(supplier)}/order-mail`);
  return orderMailPreviewSchema.parse(await readJson(response, "Náhľad mailu sa nepodarilo načítať"));
}

const sendOrderMailResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

/**
 * Odoslanie prebehlo — `ok` hovorí, či mail reálne odišiel. Na rozdiel od
 * `readJson` NEhádže na 502/503 (nenakonfigurovaný mailer/zlyhané SMTP) —
 * tie sú tu rovnocenné "no_email"/"no_items" doménovým výsledkom (odlišné len
 * HTTP kódom, `http/supplier-routes.ts`), UI ich zobrazuje rovnako ako chybu
 * poslania, nie ako neočakávanú výnimku.
 */
export async function sendSupplierOrderMail(supplier: string): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch(`/api/suppliers/${encodeURIComponent(supplier)}/order-mail/send`, {
    method: "POST",
  });
  if (response.status === 401) throw new OrdersUnauthorizedError();
  if (!response.ok) {
    return { ok: false, error: await serverErrorMessage(response, "Odoslanie objednávky mailom sa nepodarilo") };
  }
  const telo = sendOrderMailResultSchema.parse(await response.json());
  return { ok: telo.ok, ...(telo.error === undefined ? {} : { error: telo.error }) };
}
