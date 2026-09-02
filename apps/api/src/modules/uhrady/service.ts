import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { slavosportPaymentNote, slavosportPaymentScan } from "../../db/schema-uhrady.js";

// issue 543: jediná zapisovacia cesta pre Úhrady (rovnaký princíp ako
// `note`/`daily-tasks` service). Autor (`userId`) prichádza VŽDY zo session,
// nikdy z tela requestu. Zdieľané — vlastníctvo sa pri úprave/mazaní ZÁMERNE
// nevynucuje (kľúčuje sa len `eq(id)`); neznámy/už zmazaný riadok vráti
// `false`, nikdy 4xx (rovnaký „neškodné no-op" princíp ako zvyšok appky).

export interface CreatePaymentNoteInput {
  readonly userId: string;
  readonly text: string;
  readonly now: Date;
}

export interface PaymentWriteResult {
  readonly id: string;
}

export async function createPaymentNote(db: Database, input: CreatePaymentNoteInput): Promise<PaymentWriteResult> {
  const [row] = await db
    .insert(slavosportPaymentNote)
    .values({ userId: input.userId, text: input.text, createdAt: input.now, updatedAt: input.now })
    .returning({ id: slavosportPaymentNote.id });
  if (row === undefined) throw new Error("Vloženie poznámky zlyhalo bez chyby");
  return { id: row.id };
}

export interface DeletePaymentNoteInput {
  readonly id: string;
}

export async function deletePaymentNote(db: Database, input: DeletePaymentNoteInput): Promise<boolean> {
  const result = await db
    .delete(slavosportPaymentNote)
    .where(eq(slavosportPaymentNote.id, input.id))
    .returning({ id: slavosportPaymentNote.id });
  return result.length > 0;
}

export interface CreatePaymentScanInput {
  readonly userId: string;
  readonly image: Buffer;
  readonly imageMime: string;
  readonly description: string;
  readonly now: Date;
}

export async function createPaymentScan(db: Database, input: CreatePaymentScanInput): Promise<PaymentWriteResult> {
  const [row] = await db
    .insert(slavosportPaymentScan)
    .values({
      userId: input.userId,
      image: input.image,
      imageMime: input.imageMime,
      description: input.description,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: slavosportPaymentScan.id });
  if (row === undefined) throw new Error("Uloženie skenu zlyhalo bez chyby");
  return { id: row.id };
}

export interface UpdatePaymentScanDescriptionInput {
  readonly id: string;
  readonly description: string;
  readonly now: Date;
}

export async function updatePaymentScanDescription(db: Database, input: UpdatePaymentScanDescriptionInput): Promise<boolean> {
  const result = await db
    .update(slavosportPaymentScan)
    .set({ description: input.description, updatedAt: input.now })
    .where(eq(slavosportPaymentScan.id, input.id))
    .returning({ id: slavosportPaymentScan.id });
  return result.length > 0;
}

export interface DeletePaymentScanInput {
  readonly id: string;
}

export async function deletePaymentScan(db: Database, input: DeletePaymentScanInput): Promise<boolean> {
  const result = await db
    .delete(slavosportPaymentScan)
    .where(eq(slavosportPaymentScan.id, input.id))
    .returning({ id: slavosportPaymentScan.id });
  return result.length > 0;
}
