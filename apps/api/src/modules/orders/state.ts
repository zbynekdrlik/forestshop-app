import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderLines, type OrderLineState } from "../../db/schema.js";
import { record } from "../audit/service.js";

export type SetOrderLineStateResult = "ok" | "not_found";

export interface SetOrderLineStateInput {
  readonly lineId: string;
  readonly newState: OrderLineState;
  readonly actorUserId: string;
  readonly now: Date;
}

// Celý zápis beží v JEDNEJ transakcii (rovnaký vzor ako `auth/change-password.ts`
// a `catalog/ingest.ts`) — zápis nového stavu bez auditového záznamu (alebo
// naopak) by nechal históriu ("kto to spravil") nekonzistentnú so skutočným
// stavom riadku.
export async function setOrderLineState(
  db: Database,
  input: SetOrderLineStateInput,
): Promise<SetOrderLineStateResult> {
  return db.transaction(async (tx) => {
    // `.for("update")` — bez tohto by dve súbežné zmeny stavu TOHO ISTÉHO
    // riadku mohli zapísať audit s neplatným `from` (druhá transakcia by
    // prečítala stav PRED tým, než prvá commitla svoj UPDATE, nie tesne pred
    // vlastným zápisom). Výsledný stĺpec `state` by bol aj tak správny
    // (posledný zápis vyhráva), ale história ("z akého stavu do akého") by
    // klamala. Zámok drží riadok len do konca TEJTO transakcie (rovnako
    // krátko ako `changePassword`), druhá súbežná požiadavka počká na
    // COMMIT prvej a prečíta si už aktuálny stav (code review finding, #25).
    const [line] = await tx
      .select({ orderId: orderLines.orderId, variantCode: orderLines.variantCode, state: orderLines.state })
      .from(orderLines)
      .where(eq(orderLines.id, input.lineId))
      .for("update")
      .limit(1);
    if (line === undefined) return "not_found";

    await tx.update(orderLines).set({ state: input.newState }).where(eq(orderLines.id, input.lineId));

    await record(tx, {
      at: input.now,
      actorUserId: input.actorUserId,
      action: "order_line.state.changed",
      entity: "order_line",
      entityId: input.lineId,
      data: {
        orderId: line.orderId,
        variantCode: line.variantCode,
        from: line.state,
        to: input.newState,
      },
    });

    return "ok";
  });
}
