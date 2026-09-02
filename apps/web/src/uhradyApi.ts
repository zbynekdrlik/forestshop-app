import { z } from "zod";

// issue 543: "SLAVOSPORT → Úhrady" — zrkadlí `PaymentNoteRow`/`PaymentScanRow`
// (`apps/api/src/modules/uhrady/queries.ts`). ZDIEĽANÝ zoznam, takže riadok
// nesie aj `authorName`. Obrázok (bytea) sa NIKDY nevracia v zozname — grid ho
// streamuje z `uhradyScanImageUrl`.

const noteRowSchema = z.object({
  id: z.string(),
  text: z.string(),
  authorUserId: z.string(),
  authorName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PaymentNoteRow = z.infer<typeof noteRowSchema>;

const scanRowSchema = z.object({
  id: z.string(),
  description: z.string(),
  authorUserId: z.string(),
  authorName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PaymentScanRow = z.infer<typeof scanRowSchema>;

const noteListSchema = z.object({ rows: z.array(noteRowSchema) });
const scanListSchema = z.object({ rows: z.array(scanRowSchema) });

export class UhradyUnauthorizedError extends Error {
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
  if (response.status === 401) throw new UhradyUnauthorizedError();
  if (!response.ok) throw new Error(await serverErrorMessage(response, fallback));
  return await response.json();
}

// --- Poznámky ---
export async function fetchPaymentNotes(): Promise<readonly PaymentNoteRow[]> {
  const response = await fetch("/api/uhrady/notes");
  return noteListSchema.parse(await readJson(response, "Poznámky sa nepodarilo načítať")).rows;
}

export async function createPaymentNote(text: string): Promise<void> {
  const response = await fetch("/api/uhrady/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  await readJson(response, "Poznámku sa nepodarilo pridať");
}

export async function deletePaymentNote(id: string): Promise<void> {
  const response = await fetch(`/api/uhrady/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
  await readJson(response, "Poznámku sa nepodarilo odstrániť");
}

// --- Skeny FA ---
export async function fetchPaymentScans(): Promise<readonly PaymentScanRow[]> {
  const response = await fetch("/api/uhrady/scans");
  return scanListSchema.parse(await readJson(response, "Skeny sa nepodarilo načítať")).rows;
}

// Nahranie skenu (multipart). `Content-Type` sa NENASTAVUJE ručne — `fetch`
// s `FormData` doplní `multipart/form-data` s hranicou sám.
export async function createPaymentScan(file: File, description: string): Promise<void> {
  const form = new FormData();
  form.append("image", file, file.name);
  if (description !== "") form.append("description", description);
  const response = await fetch("/api/uhrady/scans", { method: "POST", body: form });
  await readJson(response, "Sken sa nepodarilo uložiť");
}

// URL na streamovanie originálu konkrétneho skenu (grid ho zmenší cez CSS,
// lightbox ukáže plnú veľkosť).
export function uhradyScanImageUrl(id: string): string {
  return `/api/uhrady/scans/${encodeURIComponent(id)}/image`;
}

export async function updatePaymentScanDescription(id: string, description: string): Promise<boolean> {
  const response = await fetch(`/api/uhrady/scans/${encodeURIComponent(id)}/description`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description }),
  });
  const body = (await readJson(response, "Popis sa nepodarilo uložiť")) as { readonly updated: boolean };
  return body.updated;
}

export async function deletePaymentScan(id: string): Promise<void> {
  const response = await fetch(`/api/uhrady/scans/${encodeURIComponent(id)}`, { method: "DELETE" });
  await readJson(response, "Sken sa nepodarilo odstrániť");
}
