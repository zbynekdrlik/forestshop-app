import { z } from "zod";

// issue 410: "Eshop → Objednávky predajňa" — zrkadlí `FloorNoteRow`/
// `FloorNoteProductRow` (`apps/api/src/modules/floor-notes/queries.ts`).
// Produktové vyhľadávanie na pripnutie ZNOVUPOUŽÍVA existujúce
// `globalSearch` (`searchApi.ts`) — žiadna nová vyhľadávacia cesta tu.

const productSchema = z.object({
  variantCode: z.string(),
  productName: z.string(),
  sizeLabel: z.string().nullable(),
  // issue 453: počet kusov (celé číslo ≥ 1).
  quantity: z.number().int(),
  shopUrl: z.string().nullable(),
});
export type FloorNoteProduct = z.infer<typeof productSchema>;

const rowSchema = z.object({
  id: z.string(),
  text: z.string(),
  resolved: z.boolean(),
  ordered: z.boolean(),
  called: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  products: z.array(productSchema),
});
export type FloorNoteRow = z.infer<typeof rowSchema>;

const listSchema = z.object({ rows: z.array(rowSchema) });

export class FloorNotesUnauthorizedError extends Error {
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
  if (response.status === 401) throw new FloorNotesUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

export async function fetchFloorNotes(): Promise<readonly FloorNoteRow[]> {
  const response = await fetch("/api/floor-notes");
  return listSchema.parse(await readJson(response, "Zoznam zápisov sa nepodarilo načítať")).rows;
}

export async function createFloorNote(text: string): Promise<void> {
  const response = await fetch("/api/floor-notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  await readJson(response, "Zápis sa nepodarilo pridať");
}

export async function updateFloorNoteText(id: string, text: string): Promise<boolean> {
  const response = await fetch(`/api/floor-notes/${encodeURIComponent(id)}/text`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = (await readJson(response, "Text sa nepodarilo upraviť")) as { readonly updated: boolean };
  return body.updated;
}

async function setMarker(id: string, marker: "resolved" | "ordered" | "called", value: boolean): Promise<boolean> {
  const response = await fetch(`/api/floor-notes/${encodeURIComponent(id)}/${marker}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });
  const body = (await readJson(response, "Označenie zlyhalo")) as { readonly updated: boolean };
  return body.updated;
}

export async function setFloorNoteResolved(id: string, value: boolean): Promise<boolean> {
  return setMarker(id, "resolved", value);
}

export async function setFloorNoteOrdered(id: string, value: boolean): Promise<boolean> {
  return setMarker(id, "ordered", value);
}

export async function setFloorNoteCalled(id: string, value: boolean): Promise<boolean> {
  return setMarker(id, "called", value);
}

export async function attachFloorNoteProduct(id: string, variantCode: string, quantity: number): Promise<void> {
  const response = await fetch(`/api/floor-notes/${encodeURIComponent(id)}/products`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ variantCode, quantity }),
  });
  await readJson(response, "Produkt sa nepodarilo pripnúť");
}

// issue 453: dodatočná úprava počtu kusov už pripnutého produktu.
export async function updateFloorNoteProductQuantity(id: string, variantCode: string, quantity: number): Promise<boolean> {
  const response = await fetch(`/api/floor-notes/${encodeURIComponent(id)}/products/${encodeURIComponent(variantCode)}/quantity`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quantity }),
  });
  const body = (await readJson(response, "Počet kusov sa nepodarilo upraviť")) as { readonly updated: boolean };
  return body.updated;
}

export async function detachFloorNoteProduct(id: string, variantCode: string): Promise<boolean> {
  const response = await fetch(`/api/floor-notes/${encodeURIComponent(id)}/products/${encodeURIComponent(variantCode)}`, {
    method: "DELETE",
  });
  const body = (await readJson(response, "Produkt sa nepodarilo odopnúť")) as { readonly removed: boolean };
  return body.removed;
}

export async function deleteFloorNote(id: string): Promise<boolean> {
  const response = await fetch(`/api/floor-notes/${encodeURIComponent(id)}`, { method: "DELETE" });
  const body = (await readJson(response, "Zápis sa nepodarilo odstrániť")) as { readonly removed: boolean };
  return body.removed;
}
