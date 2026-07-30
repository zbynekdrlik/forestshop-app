import { z } from "zod";

// Zrkadlí `PairingListItem`/`PairingSearchInput` z
// `apps/api/src/modules/pairing/queries.ts` — vlastná zod schéma namiesto
// zdieľaného typu, rovnaký vzor ako `catalogApi.ts`/`ordersApi.ts` (frontend a
// backend sú samostatné balíčky, žiadny zdieľaný typový balík medzi nimi zatiaľ
// neexistuje).
export type PairingState = "all" | "navrhnute" | "potvrdene";

const pairingItemSchema = z.object({
  variantCode: z.string(),
  variantName: z.string(),
  sizeLabel: z.string().nullable(),
  productSupplier: z.string().nullable(),
  supplierUrl: z.string().nullable(),
  state: z.enum(["navrhnute", "potvrdene"]),
  confirmedByName: z.string().nullable(),
  confirmedAt: z.string().nullable(),
});

const searchSchema = z.object({ total: z.number(), items: z.array(pairingItemSchema) });

export type PairingItem = z.infer<typeof pairingItemSchema>;

export const PAGE_SIZE = 50;

/** Relácia medzitým vypršala (401) — rovnaký vzor ako `CatalogUnauthorizedError`. */
export class PairingUnauthorizedError extends Error {
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
  if (response.status === 401) throw new PairingUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function searchPairings(input: {
  readonly q: string;
  readonly state: PairingState;
  readonly page: number;
}): Promise<z.infer<typeof searchSchema>> {
  const query = new URLSearchParams({
    q: input.q,
    state: input.state,
    page: String(input.page),
    pageSize: String(PAGE_SIZE),
  });
  const response = await fetch(`/api/pairing?${query.toString()}`);
  return searchSchema.parse(await readJson(response, "Zoznam párovania sa nepodarilo načítať"));
}

/**
 * Potvrdí párovanie variantu. `supplierUrl` VYNECHANÉ (nie `null`, nie `""`)
 * → potvrdí sa aktuálne uložená/navrhnutá adresa ("✓ jedným klikom");
 * `supplierUrl` PRÍTOMNÉ → prepíše uloženú adresu novou a rovno ju potvrdí
 * (zamietnutie pôvodného kandidáta + ručný výber inej URL).
 */
export async function confirmPairing(variantCode: string, supplierUrl?: string): Promise<void> {
  const response = await fetch("/api/pairing/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(supplierUrl === undefined ? { variantCode } : { variantCode, supplierUrl }),
  });
  await readJson(response, "Potvrdenie párovania sa nepodarilo");
}
