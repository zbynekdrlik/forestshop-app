import { z } from "zod";

// issue 239 pôvodne pridalo tento súbor pre "Eshop → Párovanie produktov"
// (obrazovka odstránená issue 400 — nahradená obrazovkou "Párovanie", issue
// 387). Súbor OSTÁVA — `saveProductLink`/`SupplierLinksUnauthorizedError`
// nižšie sú ZDIEĽANÉ so `SearchSection.tsx` (issue 240, "Eshop → Vyhľadať"),
// zrkadlí `POST /api/product-links/:productKey`
// (`apps/api/src/http/product-links-routes.ts`, ktorá NEBOLA odstránená —
// pozri `.claude/rules/product-links.md`).

/** Relácia medzitým vypršala (401) — rovnaký vzor ako `PairingUnauthorizedError`. */
export class SupplierLinksUnauthorizedError extends Error {
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
  if (response.status === 401) throw new SupplierLinksUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function saveProductLink(productKey: string, url: string): Promise<void> {
  const response = await fetch(`/api/product-links/${encodeURIComponent(productKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  await readJson(response, "Uloženie odkazu na dodávateľa sa nepodarilo");
}
