import { eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { floorNoteProducts, orderLines, orders, type OrderLineState } from "../../db/schema.js";
import { record } from "../audit/service.js";
import { recomputeFloorNoteOrdered } from "../floor-notes/service.js";
import { listOpenStatusNames } from "./open-statuses.js";
import { listOpenOrderLineIdsForSupplier, listUnresolvedFloorProductIdsForSupplier } from "./queries.js";

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

// issue 476: rýchle pole „číslo objednávky → Enter" v sekcii Riešiť —
// hromadne nastaví stav VŠETKÝCH riadkov jednej objednávky (identifikovanej
// jej Shoptet číslom `externalOrderId`). Vlastný discriminated výsledok, aby
// trasa vedela vrátiť zrozumiteľnú SK chybu pre neznáme aj zatvorené číslo.
export type SetOrderLinesStateByCodeResult =
  | { readonly status: "ok"; readonly lineCount: number }
  | { readonly status: "order_not_found" }
  | { readonly status: "order_not_open" };

export interface SetOrderLinesStateByCodeInput {
  readonly code: string;
  readonly newState: OrderLineState;
  readonly actorUserId: string;
  readonly now: Date;
}

// Jedna transakcia (rovnaký vzor ako `setOrderLineState` vyššie) — objednávka
// aj jej riadky sa zamknú (`.for("update")`), stav sa zapíše a KAŽDÁ reálna
// zmena dostane vlastný auditový záznam `order_line.state.changed` (rovnaký
// tvar ako per-riadková zmena, aby história sedela). Riadok, čo UŽ je v
// cieľovom stave, sa preskočí (žiadny zbytočný UPDATE ani audit). „Otvorená"
// objednávka = jej Shoptet `status_name` je v `order_open_status` (rovnaká
// definícia ako „Na objednanie" zoznam, `.claude/rules/orders.md`) — inak by
// označenie nemalo zmysel (riadok by sa v sekcii Riešiť aj tak nezobrazil,
// tá filtruje na otvorené stavy).
export async function setOrderLinesStateByCode(
  db: Database,
  input: SetOrderLinesStateByCodeInput,
): Promise<SetOrderLinesStateByCodeResult> {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, statusName: orders.statusName })
      .from(orders)
      .where(eq(orders.externalOrderId, input.code))
      .for("update")
      .limit(1);
    if (order === undefined) return { status: "order_not_found" as const };

    const openStatuses = await listOpenStatusNames(tx);
    if (!openStatuses.includes(order.statusName)) return { status: "order_not_open" as const };

    const lines = await tx
      .select({ id: orderLines.id, variantCode: orderLines.variantCode, state: orderLines.state })
      .from(orderLines)
      .where(eq(orderLines.orderId, order.id))
      .for("update");

    let changed = 0;
    for (const line of lines) {
      if (line.state === input.newState) continue;
      await tx.update(orderLines).set({ state: input.newState }).where(eq(orderLines.id, line.id));
      await record(tx, {
        at: input.now,
        actorUserId: input.actorUserId,
        action: "order_line.state.changed",
        entity: "order_line",
        entityId: line.id,
        data: {
          orderId: order.id,
          variantCode: line.variantCode,
          from: line.state,
          to: input.newState,
        },
      });
      changed++;
    }

    return { status: "ok" as const, lineCount: changed };
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

export type SetOrderCommentResult = "ok" | "not_found";

export interface SetOrderCommentInput {
  readonly orderId: string;
  readonly comment: string | null;
  readonly actorUserId: string;
  readonly now: Date;
}

// issue 64: manažérova voľná poznámka k CELEJ objednávke (nie k riadku,
// `order.comment` stĺpec — `.claude/rules/orders.md` vysvetľuje, prečo ho
// import nikdy neprepíše). Rovnaký vzor ako `setOrderLineState`/
// `setOrderLineOrdered` vyššie: jedna transakcia, `.for("update")` proti
// súbežnej zmene TOHO ISTÉHO záznamu (dvaja manažéri upravujú tú istú
// poznámku súčasne), audit v tej istej transakcii. `comment: null` maže
// poznámku (prázdny orezaný vstup, mapované v `orders-routes.ts`).
export async function setOrderComment(
  db: Database,
  input: SetOrderCommentInput,
): Promise<SetOrderCommentResult> {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({ comment: orders.comment })
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .for("update")
      .limit(1);
    if (order === undefined) return "not_found";

    // issue 123: `commentUpdatedAt` je jediný zdroj pravdy pre "treba
    // poznámku zapísať späť do Shoptetu" (`order-note-select.ts`) — nastaví
    // sa pri KAŽDEJ zmene, vrátane vymazania na `null`.
    await tx
      .update(orders)
      .set({ comment: input.comment, commentUpdatedAt: input.now })
      .where(eq(orders.id, input.orderId));

    await record(tx, {
      at: input.now,
      actorUserId: input.actorUserId,
      action: "order.comment.changed",
      entity: "order",
      entityId: input.orderId,
      data: { from: order.comment, to: input.comment },
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
  // issue 480: koľko predajňových (floor) riadkov skupiny akcia zasiahla —
  // interné (log/audit/test), do HTTP odpovede sa NEpridáva (existujúce testy
  // `toEqual({ ok, ordered, lineCount })`).
  readonly floorRowCount: number;
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
    // issue 480: hromadná akcia zahŕňa aj PREDAJŇOVÉ riadky skupiny — skupina
    // môže mať dokonca LEN floor riadky (žiadne objednávky), takže sa nesmie
    // predčasne vrátiť pri prázdnom `lineIds`. Prázdne OBOJE = neškodný no-op.
    const floorProducts = await listUnresolvedFloorProductIdsForSupplier(tx, input.supplier);
    if (lineIds.length === 0 && floorProducts.length === 0) return { lineCount: 0, floorRowCount: 0 };

    if (lineIds.length > 0) {
      await tx.update(orderLines).set({ ordered: input.ordered }).where(inArray(orderLines.id, [...lineIds]));
    }

    // issue 480: nastav `ordered_at` všetkých floor produktov skupiny a
    // prepočítaj note-level 🛒 každého DOTKNUTÉHO zápisu (jeden zápis môže mať
    // viac produktov v skupine — deduplikuj noteId, aby sa prepočet nezopakoval).
    if (floorProducts.length > 0) {
      await tx
        .update(floorNoteProducts)
        .set({ orderedAt: input.ordered ? input.now : null })
        .where(inArray(floorNoteProducts.id, floorProducts.map((f) => f.productId)));
      for (const noteId of [...new Set(floorProducts.map((f) => f.floorNoteId))]) {
        await recomputeFloorNoteOrdered(tx, noteId);
      }
    }

    // Review of PR 75, finding 1: pôvodne `entity: "supplier_contact"` —
    // tento zápis mutuje `order_line` riadky, nie e-mailový kontakt
    // dodávateľa, takže audit query filtrovaný podľa `entity = "order_line"`
    // by ho ticho vynechal a filter podľa `"supplier_contact"` by ho miešal s
    // nesúvisiacimi udalosťami e-mailového kontaktu. Rovnaký entity typ ako
    // KAŽDÁ iná `order_line`-mutujúca akcia v tomto súbore (`state.ts:47,94`);
    // `entityId` ostáva `null` (žiadny JEDEN riadok, na ktorý by mal
    // ukazovať — rovnaký vzor ako `orders-routes.ts`'s bulk
    // `orders.ingest.trigger` udalosť), dodávateľ + zasiahnuté ID zostávajú v
    // `data`. issue 480: `floorRowCount` doplnené (počet zasiahnutých floor
    // riadkov) — JEDEN agregovaný audit záznam pokrýva order aj floor riadky.
    await record(tx, {
      at: input.now,
      actorUserId: input.actorUserId,
      action: "order_line.ordered.bulk_changed",
      entity: "order_line",
      data: {
        supplier: input.supplier,
        ordered: input.ordered,
        lineIds,
        lineCount: lineIds.length,
        floorRowCount: floorProducts.length,
      },
    });

    return { lineCount: lineIds.length, floorRowCount: floorProducts.length };
  });
}
