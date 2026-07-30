import type { Database } from "../../db/client.js";
import { supplierContacts } from "../../db/schema.js";
import { record } from "../audit/service.js";

export interface SetSupplierContactEmailInput {
  readonly supplier: string;
  readonly email: string | null;
  readonly actorUserId: string;
  readonly now: Date;
}

// Rovnaký vzor ako `orders/state.ts`'s `setOrderLineState` — zápis novej
// hodnoty a auditový záznam v JEDNEJ transakcii (#31), aby história "kto
// nastavil e-mail dodávateľa" nikdy nezostala nekonzistentná so skutočnou
// hodnotou stĺpca.
export async function setSupplierContactEmail(db: Database, input: SetSupplierContactEmailInput): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(supplierContacts)
      .values({ supplier: input.supplier, email: input.email, updatedAt: input.now })
      .onConflictDoUpdate({
        target: supplierContacts.supplier,
        set: { email: input.email, updatedAt: input.now },
      });

    await record(tx, {
      at: input.now,
      actorUserId: input.actorUserId,
      action: "supplier_contact.email.changed",
      entity: "supplier_contact",
      entityId: input.supplier,
      data: { supplier: input.supplier, email: input.email },
    });
  });
}
