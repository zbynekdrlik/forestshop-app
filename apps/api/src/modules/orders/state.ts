import { eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderLines, type OrderLineState } from "../../db/schema.js";
import { record } from "../audit/service.js";
import { listOpenOrderLineIdsForSupplier } from "./queries.js";

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

export type SetOrderLineOrderedResult = "ok" | "not_found";

export interface SetOrderLineOrderedInput {
  readonly lineId: string;
  readonly ordered: boolean;
  readonly actorUserId: string;
  readonly now: Date;
}

// issue 60: odškrtávacie políčko "objednané u dodávateľa" — NEZÁVISLÝ
// príznak od `state` vyššie (viď komentár k `orderLines.ordered` v
// `schema-orders.ts`). Rovnaký vzor ako `setOrderLineState`: jedna
// transakcia, `.for("update")` proti tej istej race medzi dvoma súbežnými
// zmenami TOHO ISTÉHO riadku, audit v tej istej transakcii.
export async function setOrderLineOrdered(
  db: Database,
  input: SetOrderLineOrderedInput,
): Promise<SetOrderLineOrderedResult> {
  return db.transaction(async (tx) => {
    const [line] = await tx
      .select({ orderId: orderLines.orderId, variantCode: orderLines.variantCode, ordered: orderLines.ordered })
      .from(orderLines)
      .where(eq(orderLines.id, input.lineId))
      .for("update")
      .limit(1);
    if (line === undefined) return "not_found";

    await tx.update(orderLines).set({ ordered: input.ordered }).where(eq(orderLines.id, input.lineId));

    await record(tx, {
      at: input.now,
      actorUserId: input.actorUserId,
      action: "order_line.ordered.changed",
      entity: "order_line",
      entityId: input.lineId,
      data: {
        orderId: line.orderId,
        variantCode: line.variantCode,
        from: line.ordered,
        to: input.ordered,
      },
    });

    return "ok";
  });
}

export interface SetSupplierLinesOrderedInput {
  readonly supplier: string;
  readonly ordered: boolean;
  readonly actorUserId: string;
  readonly now: Date;
}

export interface SetSupplierLinesOrderedResult {
  readonly lineCount: number;
}

// issue 60: hromadné "označiť celú skupinu dodávateľa ako objednané"/zrušenie
// (stará appka's `markGroupOrdered`, bez jej `commitSeq`/optimistic-retry
// zložitosti — appka má jedného-pár súčasne prihlásených manažérov, nie
// desiatky súbežných editorov, rovnaký zámer ako zjednodušenie spomenuté v
// review na #59/#44). Zoznam dotknutých riadkov sa počíta z RIADKOV, ktoré
// `GET /api/orders/open` PRÁVE TERAZ zobrazuje pre daného dodávateľa
// (`listOpenOrderLineIdsForSupplier`) — teda presne to, čo manažér na
// obrazovke vidí, nie všetky historické riadky toho dodávateľa. Lookup +
// zápis + JEDEN agregovaný audit záznam (namiesto jedného na riadok — inak
// by kliknutie na 20-riadkovú skupinu vyrobilo 20 auditových riadkov za
// jednu manažérovu akciu) bežia VŠETKY v JEDNEJ transakcii (review of PR 75,
// finding 3 — lookup pôvodne bežal MIMO nej, `.claude/rules/orders.md`
// odkazuje na `queries.ts`'s komentár pre detail race/opravy). Prázdna
// skupina (0 riadkov) je NEŠKODNÝ no-op, nie chyba — transakcia sa aj tak
// otvorí a hneď commitne bez zápisu, nič sa nezapíše ani do auditu.
export async function setSupplierLinesOrdered(
  db: Database,
  input: SetSupplierLinesOrderedInput,
): Promise<SetSupplierLinesOrderedResult> {
  return db.transaction(async (tx) => {
    const lineIds = await listOpenOrderLineIdsForSupplier(tx, input.supplier);
    if (lineIds.length === 0) return { lineCount: 0 };

    await tx.update(orderLines).set({ ordered: input.ordered }).where(inArray(orderLines.id, [...lineIds]));

    // Review of PR 75, finding 1: pôvodne `entity: "supplier_contact"` —
    // tento zápis mutuje `order_line` riadky, nie e-mailový kontakt
    // dodávateľa, takže audit query filtrovaný podľa `entity = "order_line"`
    // by ho ticho vynechal a filter podľa `"supplier_contact"` by ho miešal s
    // nesúvisiacimi udalosťami e-mailového kontaktu. Rovnaký entity typ ako
    // KAŽDÁ iná `order_line`-mutujúca akcia v tomto súbore (`state.ts:47,94`);
    // `entityId` ostáva `null` (žiadny JEDEN riadok, na ktorý by mal
    // ukazovať — rovnaký vzor ako `orders-routes.ts`'s bulk
    // `orders.ingest.trigger` udalosť), dodávateľ + zasiahnuté ID zostávajú v
    // `data`.
    await record(tx, {
      at: input.now,
      actorUserId: input.actorUserId,
      action: "order_line.ordered.bulk_changed",
      entity: "order_line",
      data: { supplier: input.supplier, ordered: input.ordered, lineIds, lineCount: lineIds.length },
    });

    return { lineCount: lineIds.length };
  });
}
