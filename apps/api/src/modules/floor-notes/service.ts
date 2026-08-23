import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { floorNoteProducts, floorNotes, variants } from "../../db/schema.js";
import { record } from "../audit/service.js";

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
  // issue 453: počet kusov (celé číslo ≥ 1). Validáciu robí trasa (zod
  // `int().min(1)`, default 1), tu sa len zapíše.
  readonly quantity: number;
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
    .values({ floorNoteId: input.floorNoteId, variantCode: input.variantCode, quantity: input.quantity, createdAt: input.now })
    // Opätovné pripnutie TOHO ISTÉHO produktu ostáva idempotentné
    // (`.claude/rules/floor-notes.md`) — počet sa mení VÝHRADNE cez
    // `updateFloorNoteProductQuantity` (samostatná PATCH trasa), nie
    // opätovným pinom.
    .onConflictDoNothing();
  return { ok: true };
}

export interface UpdateFloorNoteProductQuantityInput {
  readonly floorNoteId: string;
  readonly variantCode: string;
  readonly quantity: number;
}

// issue 453: dodatočná úprava počtu kusov už pripnutého produktu. Nemení
// `floor_note.updated_at` — konzistentné s attach/detach, ktoré ho tiež
// nebumpujú (množstvo je atribút junction riadku, nie textu zápisu).
export async function updateFloorNoteProductQuantity(db: Database, input: UpdateFloorNoteProductQuantityInput): Promise<boolean> {
  const result = await db
    .update(floorNoteProducts)
    .set({ quantity: input.quantity })
    .where(and(eq(floorNoteProducts.floorNoteId, input.floorNoteId), eq(floorNoteProducts.variantCode, input.variantCode)))
    .returning({ id: floorNoteProducts.id });
  return result.length > 0;
}

// issue 480: prepočíta note-level 🛒 (`floor_note.ordered`) z objednaného stavu
// POLOŽIEK zápisu — `true` práve keď má zápis ≥1 položku a VŠETKY majú
// `ordered_at` nastavené, inak `false` (symetricky: odškrtnutie ktorejkoľvek
// položky 🛒 zhodí). Spúšťa sa po KAŽDEJ zmene objednaného stavu položky
// (per-item `setFloorNoteProductOrdered` nižšie AJ hromadné cez skupinu
// dodávateľa v `orders/state.ts`'s `setSupplierLinesOrdered`), VŽDY v tej istej
// transakcii. Ručný 🛒 prepínač (`setFloorNoteOrdered`) ostáva NEZÁVISLÝ —
// tento prepočet sa spúšťa len pri zmene objednaného stavu položky, nikdy pri
// pin/odpin (počty aj tak čítajú `ordered_at` per položku, ostávajú správne).
// `updated_at` sa NEbumpuje — je to odvodený dôsledok zmeny junction riadku,
// rovnaký zámer ako `updateFloorNoteProductQuantity` (množstvo je atribút
// junction riadku, nie textu zápisu). `Pick<Database, "select" | "update">` —
// prijíma aj `tx` (`PgTransaction` nemá `Database.$client`, rovnaký vzor ako
// `queries.ts`'s `Pick<Database, "select">`).
export async function recomputeFloorNoteOrdered(
  db: Pick<Database, "select" | "update">,
  floorNoteId: string,
): Promise<void> {
  const productRows = await db
    .select({ orderedAt: floorNoteProducts.orderedAt })
    .from(floorNoteProducts)
    .where(eq(floorNoteProducts.floorNoteId, floorNoteId));
  const allOrdered = productRows.length > 0 && productRows.every((r) => r.orderedAt !== null);
  await db.update(floorNotes).set({ ordered: allOrdered }).where(eq(floorNotes.id, floorNoteId));
}

export interface SetFloorNoteProductOrderedInput {
  readonly floorNoteId: string;
  readonly variantCode: string;
  readonly ordered: boolean;
  readonly actorUserId: string;
  readonly now: Date;
}

export type SetFloorNoteProductOrderedResult = "ok" | "not_found";

// issue 480: „objednané" na predajňovom riadku v board-e „Na objednanie" —
// nastaví `floor_note_product.ordered_at` (NULL = zrušené), prepočíta note-level
// 🛒 a zapíše audit, VŠETKO v jednej transakcii (rovnaký vzor ako
// `orders/state.ts`'s `setOrderLineOrdered`). `.for("update")` proti súbežnej
// zmene TEJ ISTEJ položky (audit `from` by inak mohol prečítať zastaraný stav).
export async function setFloorNoteProductOrdered(
  db: Database,
  input: SetFloorNoteProductOrderedInput,
): Promise<SetFloorNoteProductOrderedResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: floorNoteProducts.id, orderedAt: floorNoteProducts.orderedAt })
      .from(floorNoteProducts)
      .where(and(eq(floorNoteProducts.floorNoteId, input.floorNoteId), eq(floorNoteProducts.variantCode, input.variantCode)))
      .for("update")
      .limit(1);
    if (row === undefined) return "not_found";

    await tx
      .update(floorNoteProducts)
      .set({ orderedAt: input.ordered ? input.now : null })
      .where(eq(floorNoteProducts.id, row.id));
    await recomputeFloorNoteOrdered(tx, input.floorNoteId);

    await record(tx, {
      at: input.now,
      actorUserId: input.actorUserId,
      action: "floor_note_product.ordered.changed",
      entity: "floor_note_product",
      entityId: row.id,
      data: {
        floorNoteId: input.floorNoteId,
        variantCode: input.variantCode,
        from: row.orderedAt !== null,
        to: input.ordered,
      },
    });

    return "ok";
  });
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
