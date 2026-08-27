import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orders, upozornenie } from "../../db/schema.js";
import { isExchangeOrderStatus, isReturnedOrderStatus } from "./order-flags.js";
import { buildShoptetAdminOrderUrl } from "./queries.js";
import { returnUpozornenieDedupKey } from "./return-status.js";

// issue 290: čítacia strana pre "Eshop → Výmena tovaru / Vrátený tovar /
// Reklamácie" — TRI READ-ONLY pohľady nad objednávkami, ŽIADNA nová
// zapisovacia cesta do `upozornenie` (to ostáva výhradne `return-
// upozornenia.ts`/#267/#269/#297). `unresolved` sa dopočítava DVOJKROKOVO
// (najprv objednávky, potom otvorené "vratenie" karty pre ich dedup kľúče)
// — rovnaká technika ako `return-upozornenia.ts`'s dávkový pre-check,
// len bez `.for("update")` (toto je čisté čítanie, nič nezapisuje).

interface OrderFlagBaseRow {
  readonly id: string;
  readonly externalOrderId: string;
  readonly customerName: string;
  readonly statusName: string;
  readonly placedAt: Date;
  readonly totalPriceWithVat: string | null;
  readonly comment: string | null;
  readonly shoptetOrderId: number | null;
}

export interface OrderFlagRow {
  readonly id: string;
  readonly externalOrderId: string;
  readonly customerName: string;
  readonly statusName: string;
  readonly placedAt: string;
  readonly totalPriceWithVat: string | null;
  readonly comment: string | null;
  readonly adminUrl: string;
  // `true` = objednávka má ešte OTVORENÚ "vratenie" kartu na Upozorneniach
  // (`return-status.ts`'s aktívny vrátkový stav ju stále drží otvorenú,
  // alebo ju ešte nikdy nezavrel žiadny import do hotového stavu) — toto
  // JE "nevybavené" v zmysle tickety, nikdy nový, samostatný appkin stav.
  readonly unresolved: boolean;
}

// `order.status_name` nemá vlastný indexovaný zoznam pre "Výmena"/"Vrátený
// tovar" (na rozdiel od `order_open_status`) — appka má rádovo stovky
// objednávok (rovnaká úvaha o rozumnom rozsahu appky ako
// `open-statuses.ts`), takže JEDEN SELECT všetkých objednávok + filter v
// JS (obe klasifikačné funkcie sú čisté `normalizeStatusName` porovnania)
// je jednoduchšie a nepotrebuje žiadny natvrdo vypísaný zoznam reťazcov v
// SQL `inArray`.
async function selectAllBaseRows(db: Database): Promise<readonly OrderFlagBaseRow[]> {
  return db
    .select({
      id: orders.id,
      externalOrderId: orders.externalOrderId,
      customerName: orders.customerName,
      statusName: orders.statusName,
      placedAt: orders.placedAt,
      totalPriceWithVat: orders.totalPriceWithVat,
      comment: orders.comment,
      shoptetOrderId: orders.shoptetOrderId,
    })
    .from(orders)
    .orderBy(desc(orders.placedAt));
}

/** Množina "vratenie" dedup kľúčov (`return-status.ts`), ktoré MAJÚ ešte
 * otvorenú (nevyriešenú) kartu — pre presne tie objednávky, čo `rows`
 * odovzdá. Prázdny vstup nikdy nesiahne na DB (`inArray([])` by inak
 * vygenerovalo vždy-nepravdivú podmienku zbytočne). */
async function unresolvedDedupKeySet(db: Database, rows: readonly OrderFlagBaseRow[]): Promise<ReadonlySet<string>> {
  if (rows.length === 0) return new Set();
  const dedupKeys = rows.map((r) => returnUpozornenieDedupKey(r.externalOrderId));
  const openCards = await db
    .select({ dedupKey: upozornenie.dedupKey })
    .from(upozornenie)
    .where(and(eq(upozornenie.type, "vratenie"), inArray(upozornenie.dedupKey, dedupKeys), isNull(upozornenie.resolvedAt)));
  return new Set(openCards.map((c) => c.dedupKey).filter((k): k is string => k !== null));
}

function toFlagRow(row: OrderFlagBaseRow, adminBaseUrl: string, unresolved: boolean): OrderFlagRow {
  return {
    id: row.id,
    externalOrderId: row.externalOrderId,
    customerName: row.customerName,
    statusName: row.statusName,
    placedAt: row.placedAt.toISOString(),
    totalPriceWithVat: row.totalPriceWithVat,
    comment: row.comment,
    adminUrl: buildShoptetAdminOrderUrl(adminBaseUrl, row.externalOrderId, row.shoptetOrderId),
    unresolved,
  };
}

/** Zdieľané jadro pre "Výmena tovaru"/"Vrátený tovar": vyfiltruje podľa
 * `statusFilter`, dopočíta `unresolved` (viď `unresolvedDedupKeySet`
 * vyššie), vráti surové riadky BEZ `adminUrl` — volajúci (list alebo
 * count) si adminUrl doplní/vynechá podľa potreby. */
async function selectFlaggedByStatus(
  db: Database,
  statusFilter: (statusName: string) => boolean,
): Promise<readonly (OrderFlagBaseRow & { readonly unresolved: boolean })[]> {
  const rows = (await selectAllBaseRows(db)).filter((r) => statusFilter(r.statusName));
  const openSet = await unresolvedDedupKeySet(db, rows);
  return rows.map((r) => ({ ...r, unresolved: openSet.has(returnUpozornenieDedupKey(r.externalOrderId)) }));
}

export async function listExchangeOrders(db: Database, adminBaseUrl: string): Promise<readonly OrderFlagRow[]> {
  const rows = await selectFlaggedByStatus(db, isExchangeOrderStatus);
  return rows.map((r) => toFlagRow(r, adminBaseUrl, r.unresolved));
}

export async function listReturnedOrders(db: Database, adminBaseUrl: string): Promise<readonly OrderFlagRow[]> {
  const rows = await selectFlaggedByStatus(db, isReturnedOrderStatus);
  return rows.map((r) => toFlagRow(r, adminBaseUrl, r.unresolved));
}

export interface ClaimOrderRow extends OrderFlagRow {
  readonly claimNote: string | null;
  readonly claimMarkedAt: string;
}

/** Aktuálne označené reklamácie — appka nemá koncept "vybavené" mimo
 * samotného zrušenia označenia (`clearOrderClaim`, `order-flags-state.ts`),
 * takže KAŽDÁ tu vrátená objednávka je "nevybavená" (rozhodnuté na
 * tickete — žiadny druhý stav navyše). */
export async function listClaimOrders(db: Database, adminBaseUrl: string): Promise<readonly ClaimOrderRow[]> {
  const rows = await db
    .select({
      id: orders.id,
      externalOrderId: orders.externalOrderId,
      customerName: orders.customerName,
      statusName: orders.statusName,
      placedAt: orders.placedAt,
      totalPriceWithVat: orders.totalPriceWithVat,
      comment: orders.comment,
      shoptetOrderId: orders.shoptetOrderId,
      claimNote: orders.claimNote,
      claimMarkedAt: orders.claimMarkedAt,
    })
    .from(orders)
    .where(isNotNull(orders.claimMarkedAt))
    .orderBy(desc(orders.claimMarkedAt));
  return rows.map((r) => ({
    ...toFlagRow(r, adminBaseUrl, true),
    claimNote: r.claimNote,
    // `where(isNotNull(...))` vyššie zaručuje non-null — `??` len upokojí
    // TS bez `!` assercie na `Date | null`.
    claimMarkedAt: (r.claimMarkedAt ?? new Date(0)).toISOString(),
  }));
}

export interface OrderFlagCounts {
  readonly exchange: number;
  readonly returned: number;
  readonly claims: number;
}

/** Počty pre odznaky v ľavom menu (`nav.ts`):
 * - `exchange` = počet VŠETKÝCH aktívnych výmen (stav "Výmena tovaru") — issue
 *   514, Štěpán: „koľko objendávok so stavom Výmena tovaru je aktualnych".
 *   Zdieľa PRESNE tú istú dátovú cestu ako výpis (`selectFlaggedByStatus(db,
 *   isExchangeOrderStatus)`), takže badge == dĺžka výpisu, žiadny duplicitný
 *   count. NIE je unresolved-filtrovaný — stav "Výmena tovaru" nezakladá
 *   "vratenie" kartu (`return-status.ts`), takže `unresolved` je preň prakticky
 *   vždy false; filtrovať by badge navždy skrylo.
 * - `returned` = počet NEVYBAVENÝCH vrátení (`unresolved`) — nezmenené, "Vratený
 *   tovar" JE aktívny vrátkový stav s kartami.
 * - `claims` = počet AKTUÁLNE OZNAČENÝCH (žiadny ďalší "vybavené" koncept). */
export async function countOrderFlags(db: Database): Promise<OrderFlagCounts> {
  const [exchangeRows, returnedRows, claimRows] = await Promise.all([
    selectFlaggedByStatus(db, isExchangeOrderStatus),
    selectFlaggedByStatus(db, isReturnedOrderStatus),
    db.select({ id: orders.id }).from(orders).where(isNotNull(orders.claimMarkedAt)),
  ]);
  return {
    exchange: exchangeRows.length,
    returned: returnedRows.filter((r) => r.unresolved).length,
    claims: claimRows.length,
  };
}
