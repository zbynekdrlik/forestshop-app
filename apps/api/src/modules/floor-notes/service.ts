import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { floorNoteProducts, floorNotes, variants } from "../../db/schema.js";

export interface CreateFloorNoteInput {
  readonly text: string;
  readonly createdByUserId: string;
  readonly now: Date;
}

export interface FloorNoteWriteResult {
  readonly id: string;
}

// Jediná zapisovacia cesta pre NOVÝ zápis — rovnaký princíp ako
// `.claude/rules/mail-log.md`/`upozornenia`'s "jediná zapisovacia cesta".
export async function createFloorNote(db: Database, input: CreateFloorNoteInput): Promise<FloorNoteWriteResult> {
  const [row] = await db
    .insert(floorNotes)
    .values({ text: input.text, createdByUserId: input.createdByUserId, createdAt: input.now, updatedAt: input.now })
    .returning({ id: floorNotes.id });
  if (row === undefined) throw new Error("Vloženie zápisu zlyhalo bez chyby");
  return { id: row.id };
}

export interface UpdateFloorNoteTextInput {
  readonly id: string;
  readonly text: string;
  readonly now: Date;
}

export async function updateFloorNoteText(db: Database, input: UpdateFloorNoteTextInput): Promise<boolean> {
  const result = await db
    .update(floorNotes)
    .set({ text: input.text, updatedAt: input.now })
    .where(eq(floorNotes.id, input.id))
    .returning({ id: floorNotes.id });
  return result.length > 0;
}

export interface SetFloorNoteMarkerInput {
  readonly id: string;
  readonly value: boolean;
  readonly now: Date;
}

// Tri samostatné funkcie (nie jedna generická "nastav pole podľa mena") —
// rovnaký vzor ako `daily-tasks/service.ts`'s `updateDailyTaskText`/
// `updateDailyTaskEmoji`/`setDailyTaskDone`: zrkadlí tri samostatné
// nezávislé UI akcie (klik na ✅/🛒/📞), žiadna z nich nemá ďalšiu funkciu
// (ticket to hovorí explicitne).
export async function setFloorNoteResolved(db: Database, input: SetFloorNoteMarkerInput): Promise<boolean> {
  const result = await db
    .update(floorNotes)
    .set({ resolved: input.value, updatedAt: input.now })
    .where(eq(floorNotes.id, input.id))
    .returning({ id: floorNotes.id });
  return result.length > 0;
}

export async function setFloorNoteOrdered(db: Database, input: SetFloorNoteMarkerInput): Promise<boolean> {
  const result = await db
    .update(floorNotes)
    .set({ ordered: input.value, updatedAt: input.now })
    .where(eq(floorNotes.id, input.id))
    .returning({ id: floorNotes.id });
  return result.length > 0;
}

export async function setFloorNoteCalled(db: Database, input: SetFloorNoteMarkerInput): Promise<boolean> {
  const result = await db
    .update(floorNotes)
    .set({ called: input.value, updatedAt: input.now })
    .where(eq(floorNotes.id, input.id))
    .returning({ id: floorNotes.id });
  return result.length > 0;
}

export interface DeleteFloorNoteInput {
  readonly id: string;
}

// `floor_note_product` riadky zmiznú samé (`onDelete: "cascade"`,
// `schema-floor-notes.ts`) — žiadny extra delete tu treba.
export async function deleteFloorNote(db: Database, input: DeleteFloorNoteInput): Promise<boolean> {
  const result = await db.delete(floorNotes).where(eq(floorNotes.id, input.id)).returning({ id: floorNotes.id });
  return result.length > 0;
}

export interface AttachFloorNoteProductInput {
  readonly floorNoteId: string;
  readonly variantCode: string;
  readonly now: Date;
}

export type AttachFloorNoteProductResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "note_not_found" | "product_not_found" };

// Overuje OBOJE existenciu (záznam aj produkt) TU, nie len vo frontende —
// rovnaká disciplína ako `.claude/rules/orders.md`'s issue 86 nález
// ("pravidlo vypočítané na čítacej strane sa nikdy nesmie spoliehať len na
// frontend"). Opakované pripnutie TOHO ISTÉHO produktu je idempotentné
// (`onConflictDoNothing`, unique index `floor_note_product_note_variant_uq`)
// — appka to nerieši chybou, "Pripnúť" jednoducho nič nezmení.
export async function attachFloorNoteProduct(db: Database, input: AttachFloorNoteProductInput): Promise<AttachFloorNoteProductResult> {
  const [note] = await db.select({ id: floorNotes.id }).from(floorNotes).where(eq(floorNotes.id, input.floorNoteId));
  if (note === undefined) return { ok: false, error: "note_not_found" };
  const [variant] = await db.select({ code: variants.code }).from(variants).where(eq(variants.code, input.variantCode));
  if (variant === undefined) return { ok: false, error: "product_not_found" };

  await db
    .insert(floorNoteProducts)
    .values({ floorNoteId: input.floorNoteId, variantCode: input.variantCode, createdAt: input.now })
    .onConflictDoNothing();
  return { ok: true };
}

export interface DetachFloorNoteProductInput {
  readonly floorNoteId: string;
  readonly variantCode: string;
}

export async function detachFloorNoteProduct(db: Database, input: DetachFloorNoteProductInput): Promise<boolean> {
  const result = await db
    .delete(floorNoteProducts)
    .where(and(eq(floorNoteProducts.floorNoteId, input.floorNoteId), eq(floorNoteProducts.variantCode, input.variantCode)))
    .returning({ id: floorNoteProducts.id });
  return result.length > 0;
}
