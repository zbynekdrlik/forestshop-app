import { createHash } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orders } from "../../db/schema.js";
import { log } from "../../logger.js";
import { storeRawSnapshot } from "../catalog/raw-store.js";
import { formatDateParam, redactSourceLabel, type OrderIdsFetcher } from "./fetcher.js";
import { fetchOrderIdsBestEffort, INGEST_ORDERS_ADVISORY_LOCK_KEY, type OrdersExportFetcher } from "./ingest.js";
import {
  chunk,
  ORDERS_INGEST_BATCH_SIZE,
  ORDERS_UNCHANGED_CONSEQUENCE,
  parseOrdersExport,
  structuralRejectionReason,
  upsertOrdersAndLines,
  type OrderInfo,
} from "./ingest-materialize.js";
import { listOpenStatusNames } from "./open-statuses.js";

// issue 595: JEDNORAZOVÝ doimport OTVORENÝCH objednávok starších než úplne prvý
// import. Bežný import (`ingestOrders`, každých 15 min) sťahuje 90-dňové okno a
// `backfill.ts`'s `computeOrdersExportWindowStart` (issue 492) ho predĺži iba po
// najstaršiu otvorenú objednávku, ktorá UŽ JE v DB — objednávka staršia než prvý
// import (20260707 Šulcová, 24. 4. 2026; najstaršia v DB 30. 4.) sa preto nikdy
// nenačíta, hoci je v Shoptete stále "Vybavuje sa".
//
// Tento doimport stiahne export za `[from, najstaršia objednávka v DB]` TÝM ISTÝM
// fetcherom/parserom/zápisom ako bežný import (`ingest-materialize.ts`) a zapíše
// LEN objednávky, ktoré sú (a) v stave z `listOpenStatusNames()` a (b) v DB ešte
// NIE SÚ. Zámerne NESPÚŠŤA nič, čo by siahlo na existujúce objednávky alebo na
// uzavreté staré objednávky:
//   - žiadna akceptačná brána okna (porovnáva počty riadkov v DB za okno — tu by
//     nemala zmysel, okno pred prvým importom je v DB prázdne);
//   - žiadne mazanie zastaraných riadkov (issue 412) ani prepis existujúcej
//     objednávky — objednávka, ktorá v DB už je, sa vôbec nezapisuje;
//   - žiadne Upozornenia (vrátenie/visiaca objednávka) — doimportovaná otvorená
//     objednávka je od tej chvíle v DB, takže okno z issue 492 ju pri KAŽDOM
//     ďalšom bežnom importe zachytí a tie háky zbehnú tam, presne ako pre
//     ktorúkoľvek inú otvorenú objednávku.
// Uzavreté staré objednávky (~3700 v exporte 1. 1. 2025 – 1. 5. 2026) sa
// nezapíšu nikdy — inak by zaplavili sekcie a počítadlá nad `status_name`
// (Vrátený tovar, Výmena, štatistiky), dôvod zamietnutia trvalého rozšírenia okna.
// Opakovaný beh je bezpečný: už zapísaná objednávka spadne do (b) a preskočí sa.

export interface BackfillExportWindow {
  readonly dateFrom: Date;
  readonly dateUntil: Date;
}

export interface BackfillOpenOrdersOptions {
  readonly from: Date;
  readonly now: Date;
  readonly rawDir: string;
  // Fetcher sa stavia AŽ z vypočítaného okna (`dateUntil` = najstaršia
  // objednávka v DB) — preto továreň, nie hotový fetcher ako `ingestOrders`.
  readonly createExportFetcher: (window: BackfillExportWindow) => OrdersExportFetcher;
  // issue 120/132: nepovinný XML export s interným Shoptet id (odkaz priamo na
  // detail objednávky) — best-effort rovnako ako pri bežnom importe.
  readonly createOrderIdsFetcher?: (window: BackfillExportWindow) => OrderIdsFetcher;
}

export type BackfillOpenOrdersResult =
  | {
      readonly status: "accepted";
      readonly dateFrom: Date;
      readonly dateUntil: Date;
      // objednávky prečítané z exportu (len tie s aspoň jedným skutočným produktom)
      readonly readOrderCount: number;
      // z nich v otvorenom stave
      readonly openOrderCount: number;
      // otvorené, ktoré v DB už boli (nezapisujú sa)
      readonly alreadyPresentCount: number;
      readonly insertedOrderCount: number;
      readonly insertedLineCount: number;
      readonly skippedItemCount: number;
      readonly insertedExternalOrderIds: readonly string[];
      readonly rawPath: string;
    }
  | { readonly status: "rejected"; readonly reason: string; readonly rawPath: string | null };

async function oldestOrderPlacedAt(db: Pick<Database, "select">): Promise<Date | null> {
  const [row] = await db.select({ oldest: sql<string | null>`min(${orders.placedAt})` }).from(orders);
  // `min()` cez raw `sql` neprejde drizzle-ovým stĺpcovým mapperom — pg vracia
  // ISO reťazec (rovnaká poznámka ako `backfill.ts`'s `oldestOpenOrderPlacedAt`).
  return row?.oldest === null || row?.oldest === undefined ? null : new Date(row.oldest);
}

function reject(reason: string, rawPath: string | null, detail: Record<string, unknown>): BackfillOpenOrdersResult {
  log.warn({ ...detail, reason, rawPath }, "doimport otvorených objednávok odmietnutý — databáza zostáva nezmenená");
  return { status: "rejected", reason, rawPath };
}

export async function backfillOpenOrders(db: Database, options: BackfillOpenOrdersOptions): Promise<BackfillOpenOrdersResult> {
  const oldest = await oldestOrderPlacedAt(db);
  if (oldest === null) {
    return reject(
      `V databáze nie je žiadna objednávka — na prvý import použite bežný import objednávok (orders-ingest). ${ORDERS_UNCHANGED_CONSEQUENCE}`,
      null,
      { from: options.from.toISOString() },
    );
  }
  if (options.from.getTime() >= oldest.getTime()) {
    return reject(
      `Začiatok doimportu (${formatDateParam(options.from)}) nie je starší než najstaršia objednávka v databáze (${oldest.toISOString()}) — nie je čo doimportovať. ${ORDERS_UNCHANGED_CONSEQUENCE}`,
      null,
      { from: options.from.toISOString(), oldestPlacedAt: oldest.toISOString() },
    );
  }

  const window: BackfillExportWindow = { dateFrom: options.from, dateUntil: oldest };
  log.info(
    { dateFrom: window.dateFrom.toISOString(), dateUntil: window.dateUntil.toISOString(), hasXmlIds: options.createOrderIdsFetcher !== undefined },
    "doimport otvorených objednávok: sťahujem export staršieho obdobia",
  );

  const download = await options.createExportFetcher(window)();
  const orderIdsByCode = await fetchOrderIdsBestEffort(options.createOrderIdsFetcher?.(window));
  if (download.body.byteLength === 0) {
    return reject(`Stiahnutý súbor je prázdny (0 bajtov). ${ORDERS_UNCHANGED_CONSEQUENCE}`, null, {
      sourceLabel: redactSourceLabel(download.sourceLabel),
    });
  }

  // Surové bajty PRED parsovaním — rovnaký dôvod ako `ingestOrders` (dôkaz aj pri
  // neúspešnom parsovaní). Ten istý `rawDir`, takže ich čistí ten istý `pruneRawOrders`.
  const rawPath = await storeRawSnapshot(options.rawDir, {
    at: options.now,
    sha256: createHash("sha256").update(download.body).digest("hex"),
    body: download.body,
  });

  const parsed = parseOrdersExport(download.body);
  const structural = structuralRejectionReason(parsed);
  if (structural !== null) return reject(structural, rawPath, { malformedRowCount: parsed.malformedRowCount });

  return db.transaction(async (tx): Promise<BackfillOpenOrdersResult> => {
    // Ten istý zámok ako bežný import (`ingestOrders`) — doimport nesmie bežať
    // súbežne s 15-min importom; MUSÍ byť prvý príkaz v transakcii a "čo už v DB
    // je" sa číta AŽ PO ňom (inak by súbežne zapísanú objednávku prepísal).
    await tx.execute(sql`select pg_advisory_xact_lock(${INGEST_ORDERS_ADVISORY_LOCK_KEY})`);

    const openStatuses = new Set(await listOpenStatusNames(tx));
    const open = [...parsed.orderInfo].filter(([, info]) => openStatuses.has(info.statusName));

    const present = new Set<string>();
    for (const batch of chunk(open.map(([code]) => code), ORDERS_INGEST_BATCH_SIZE)) {
      if (batch.length === 0) continue;
      const rows = await tx
        .select({ externalOrderId: orders.externalOrderId })
        .from(orders)
        .where(inArray(orders.externalOrderId, batch));
      for (const row of rows) present.add(row.externalOrderId);
    }

    const toInsert = new Map<string, OrderInfo>(open.filter(([code]) => !present.has(code)));
    const lines = parsed.allLines.filter((line) => toInsert.has(line.externalOrderId));
    const { insertedLineCount, skippedItemCount } = await upsertOrdersAndLines(tx, {
      orderInfo: toInsert,
      orderExtraByCode: parsed.orderExtraByCode,
      orderIdsByCode,
      lines,
    });

    for (const [externalOrderId, info] of toInsert) {
      log.info(
        {
          externalOrderId,
          placedAt: info.placedAt.toISOString(),
          statusName: info.statusName,
          lineCount: lines.filter((line) => line.externalOrderId === externalOrderId).length,
          shoptetOrderId: orderIdsByCode.get(externalOrderId) ?? null,
        },
        "doimport otvorených objednávok: objednávka zapísaná",
      );
    }

    const result: BackfillOpenOrdersResult = {
      status: "accepted",
      dateFrom: window.dateFrom,
      dateUntil: window.dateUntil,
      readOrderCount: parsed.orderInfo.size,
      openOrderCount: open.length,
      alreadyPresentCount: present.size,
      insertedOrderCount: toInsert.size,
      insertedLineCount,
      skippedItemCount,
      insertedExternalOrderIds: [...toInsert.keys()],
      rawPath,
    };
    log.info(
      {
        ...result,
        dateFrom: window.dateFrom.toISOString(),
        dateUntil: window.dateUntil.toISOString(),
        openStatuses: [...openStatuses],
        pseudoItemCount: parsed.pseudoItemCount,
        issueCount: parsed.issues.length,
      },
      "doimport otvorených objednávok dokončený",
    );
    return result;
  });
}
