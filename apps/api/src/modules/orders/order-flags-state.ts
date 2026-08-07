import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orders } from "../../db/schema.js";
import { record } from "../audit/service.js";

// issue 290: JEDINÁ zapisovacia cesta pre appkinu vlastnú reklamácia-
// značku (`schema-orders.ts`'s `claimMarkedAt`/`claimNote`) — rovnaký
// "celý zápis v jednej transakcii spolu s auditom" vzor ako `orders/
// state.ts`'s `setOrderLineState`.

export type MarkOrderClaimResult = { readonly status: "ok"; readonly orderId: string } | { readonly status: "not_found" };

export interface MarkOrderClaimInput {
  readonly orderCode: string;
  readonly note: string | null;
  readonly actorUserId: string;
  readonly now: Date;
}

/** Označí objednávku (podľa Shoptet čísla, presne to, čo obsluha pozná a
 * má poruke) ako reklamáciu. Opakované označenie tej istej objednávky
 * jednoducho PREPÍŠE poznámku a čas — nie je to chyba, obsluha si tak môže
 * poznámku doplniť/opraviť bez toho, aby musela najprv zrušiť a znova
 * označiť. */
export async function markOrderClaim(db: Database, input: MarkOrderClaimInput): Promise<MarkOrderClaimResult> {
  return db.transaction(async (tx) => {
    const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.externalOrderId, input.orderCode)).limit(1);
    if (order === undefined) return { status: "not_found" };

    await tx.update(orders).set({ claimMarkedAt: input.now, claimNote: input.note }).where(eq(orders.id, order.id));

    await record(tx, {
      at: input.now,
      actorUserId: input.actorUserId,
      action: "order.claim.marked",
      entity: "order",
      entityId: order.id,
      data: { orderCode: input.orderCode, note: input.note },
    });

    return { status: "ok", orderId: order.id };
  });
}

export type ClearOrderClaimResult = "ok" | "not_found";

export interface ClearOrderClaimInput {
  readonly orderId: string;
  readonly actorUserId: string;
  readonly now: Date;
}

export async function clearOrderClaim(db: Database, input: ClearOrderClaimInput): Promise<ClearOrderClaimResult> {
  return db.transaction(async (tx) => {
    const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, input.orderId)).limit(1);
    if (order === undefined) return "not_found";

    await tx.update(orders).set({ claimMarkedAt: null, claimNote: null }).where(eq(orders.id, input.orderId));

    await record(tx, {
      at: input.now,
      actorUserId: input.actorUserId,
      action: "order.claim.cleared",
      entity: "order",
      entityId: input.orderId,
    });

    return "ok";
  });
}
