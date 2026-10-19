// issue 595: JEDNORAZOVÝ doimport OTVORENÝCH objednávok starších než prvý import:
//   node apps/api/dist/cli/orders-backfill-open.js --from 2025-01-01
// (na PROD vnútri kontajnera appky, kde sú DATABASE_URL / SHOPTET_ORDERS_URL /
// SHOPTET_ORDERS_XML_URL / ORDERS_RAW_DIR už nastavené).
//
// Rovnaký vzor ako `cli/orders-ingest.ts` — žije v `apps/api/src`, takže ho
// `tsc -b` skompiluje do `apps/api/dist/cli/`, ktorý Dockerfile UŽ kopíruje do
// produkčného obrazu. Logika je v `modules/orders/backfill-open.ts` (ten istý
// fetcher/parser/zápis ako bežný import, LEN otvorené objednávky, ktoré v DB ešte
// nie sú — nič existujúce nemení ani nemaže, opakovaný beh nič nepridá).
// Exit kód 1 = odmietnuté (operátor sa spolieha na $?, nie len na text).
import { createDb } from "../db/client.js";
import { loadEnv } from "../env.js";
import { backfillOpenOrders, type BackfillOpenOrdersResult } from "../modules/orders/backfill-open.js";
import { parseBackfillFromArg } from "../modules/orders/backfill-open-args.js";
import { createHttpOrderIdsFetcher, createHttpOrdersExportFetcher } from "../modules/orders/fetcher.js";

function popis(result: BackfillOpenOrdersResult): string {
  switch (result.status) {
    case "accepted":
      return (
        `Doimport hotový (okno ${result.dateFrom.toISOString()} – ${result.dateUntil.toISOString()}): ` +
        `prečítaných ${String(result.readOrderCount)} objednávok, otvorených ${String(result.openOrderCount)}, ` +
        `už v databáze ${String(result.alreadyPresentCount)}, vložených ${String(result.insertedOrderCount)} ` +
        `(${String(result.insertedLineCount)} riadkov, ${String(result.skippedItemCount)} položiek neznámeho variantu preskočených)` +
        (result.insertedExternalOrderIds.length > 0 ? `: ${result.insertedExternalOrderIds.join(", ")}.` : ".")
      );
    case "rejected":
      return `Doimport odmietnutý: ${result.reason}`;
  }
}

const from = parseBackfillFromArg(process.argv.slice(2));
const env = loadEnv();
const ordersUrl = env.SHOPTET_ORDERS_URL;
if (ordersUrl === undefined) {
  throw new Error("Chýba SHOPTET_ORDERS_URL — bez adresy exportu sa nedá nič stiahnuť");
}
const ordersXmlUrl = env.SHOPTET_ORDERS_XML_URL;

const { db, pool } = createDb(env.DATABASE_URL);
let result: BackfillOpenOrdersResult;
try {
  result = await backfillOpenOrders(db, {
    from,
    now: new Date(),
    rawDir: env.ORDERS_RAW_DIR,
    createExportFetcher: ({ dateFrom, dateUntil }) => createHttpOrdersExportFetcher({ url: ordersUrl, dateFrom, dateUntil }),
    ...(ordersXmlUrl === undefined
      ? {}
      : {
          createOrderIdsFetcher: ({ dateFrom, dateUntil }) => createHttpOrderIdsFetcher({ url: ordersXmlUrl, dateFrom, dateUntil }),
        }),
  });
} finally {
  await pool.end();
}

console.log(popis(result));
console.log(JSON.stringify(result));
if (result.status === "rejected") process.exitCode = 1;
