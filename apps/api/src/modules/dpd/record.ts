import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { dpdPickupRequests, dpdShipments } from "../../db/schema.js";

/**
 * issue 292: appka-vlastný záznam pokusu o vytvorenie DPD zásielky (nikdy
 * Shoptetovo pole — na rozdiel od `order.package_number`, ktoré ostáva
 * NEDOTKNUTÉ). Jeden riadok NA OBJEDNÁVKU (`dpdShipments.orderId` unique) —
 * OPAKOVANÝ pokus (retry po zlyhaní) PREPÍŠE ten istý riadok, appka teda
 * vždy vidí len POSLEDNÝ pokus, nikdy históriu (`.claude/rules/dpd.md`).
 */
export interface DpdShipmentAttemptInput {
  readonly orderId: string;
  readonly weightKg: string;
  readonly codAmount: string | null;
}

export async function recordDpdShipmentSuccess(db: Database, input: DpdShipmentAttemptInput, parcelNumber: string): Promise<void> {
  await db
    .insert(dpdShipments)
    .values({ orderId: input.orderId, status: "submitted", weightKg: input.weightKg, codAmount: input.codAmount, parcelNumber })
    .onConflictDoUpdate({
      target: dpdShipments.orderId,
      set: {
        status: "submitted",
        weightKg: input.weightKg,
        codAmount: input.codAmount,
        parcelNumber,
        errorMessage: null,
        submittedAt: new Date(),
      },
    });
}

export async function recordDpdShipmentFailure(db: Database, input: DpdShipmentAttemptInput, errorMessage: string): Promise<void> {
  await db
    .insert(dpdShipments)
    .values({ orderId: input.orderId, status: "failed", weightKg: input.weightKg, codAmount: input.codAmount, errorMessage })
    .onConflictDoUpdate({
      target: dpdShipments.orderId,
      set: {
        status: "failed",
        weightKg: input.weightKg,
        codAmount: input.codAmount,
        errorMessage,
        submittedAt: new Date(),
      },
    });
}

export async function listDpdShipmentByOrderId(db: Database, orderId: string) {
  const rows = await db.select().from(dpdShipments).where(eq(dpdShipments.orderId, orderId)).limit(1);
  return rows[0] ?? null;
}

/** "Objednať zvoz na deň" — jednorazový zvoz NIE JE viazaný na objednávku
 * (`.claude/rules/dpd.md`), appka len zaznamená POKUS (žiadny upsert — každý
 * deň je nezávislá udalosť, na rozdiel od zásielok vyššie). */
export async function recordDpdPickupRequest(
  db: Database,
  input: { readonly pickupDate: string; readonly status: "submitted" | "failed"; readonly errorMessage: string | null },
): Promise<void> {
  await db.insert(dpdPickupRequests).values(input);
}
