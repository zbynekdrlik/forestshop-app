// Ručný import objednávok z príkazového riadka (#21):
//   DATABASE_URL=… SHOPTET_ORDERS_URL=… node apps/api/dist/cli/orders-ingest.js
//
// Toto je KANONICKÁ implementácia (rovnaký vzor ako `cli/catalog-prune-raw.ts`,
// pozri `.claude/rules/deploy.md`) — žije PRIAMO v `apps/api/src`, takže ju
// `apps/api`'s vlastný `tsc -b` skompiluje do `apps/api/dist/cli/
// orders-ingest.js`, ktorý Dockerfile UŽ kopíruje (celý `apps/api/dist`) do
// produkčného obrazu. Objednávky ešte NEMAJÚ HTTP trasu ani plánovač (#22/#23,
// mimo scope tohto ticketu) — bez tohto by na produkčnom hostiteľovi
// neexistoval ŽIADEN spôsob, ako import vôbec spustiť (rovnaký dôvod, prečo
// `catalog-prune-raw` dostal tento istý vzor: `scripts/` na dev2 je len
// rsync-nutá kópia BEZ `node_modules`, takže `tsx` tam nemá ako bežať).
// `scripts/orders-ingest.ts` je len jej tenký lokálny/CI alias.
//
// Exit kód rozlišuje prijatý import od odmietnutého — operátor sa spolieha
// na $?, nie len na text výstupu (rovnaká disciplína ako `scripts/catalog-ingest.ts`).
import { createDb } from "../db/client.js";
import { loadEnv } from "../env.js";
import { computeOrderIdsWindowStart } from "../modules/orders/backfill.js";
import { computeImportWindow, createHttpOrderIdsFetcher, createHttpOrdersExportFetcher } from "../modules/orders/fetcher.js";
import {
  DEFAULT_ORDERS_IMPORT_WINDOW_DAYS,
  ingestOrders,
  type OrdersIngestResult,
} from "../modules/orders/ingest.js";

function popis(result: OrdersIngestResult): string {
  switch (result.status) {
    case "accepted":
      return (
        `Import prijatý: ${String(result.orderCount)} objednávok, ` +
        `${String(result.lineCount)} riadkov, ${String(result.skippedItemCount)} položiek ` +
        `neznámeho variantu preskočených, ${String(result.pseudoItemCount)} položiek dopravy/platby/zľavy ` +
        `ignorovaných, ${String(result.issueCount)} problémov so záznamami, ` +
        `${String(result.deletedStaleLineCount)} zastaraných riadkov (vymenený/odstránený produkt) zmazaných.`
      );
    case "rejected":
      return `Import odmietnutý: ${result.reason}`;
  }
}

const env = loadEnv();
if (env.SHOPTET_ORDERS_URL === undefined) {
  throw new Error("Chýba SHOPTET_ORDERS_URL — bez adresy exportu sa nedá nič stiahnuť");
}

const now = new Date();
const { dateFrom, dateUntil } = computeImportWindow(now, DEFAULT_ORDERS_IMPORT_WINDOW_DAYS);

const ordersXmlUrl = env.SHOPTET_ORDERS_XML_URL;

const { db, pool } = createDb(env.DATABASE_URL);
let result: OrdersIngestResult;
try {
  // issue 132: pozri rovnaký komentár v `index.ts` — XML id-fetch okno sa
  // sebaozdravujúco predĺži dozadu, keď existuje otvorená objednávka bez id
  // staršia než predvolené okno.
  const idsDateFrom = ordersXmlUrl === undefined ? dateFrom : await computeOrderIdsWindowStart(db, dateFrom);
  result = await ingestOrders(db, {
    fetchExport: createHttpOrdersExportFetcher({ url: env.SHOPTET_ORDERS_URL, dateFrom, dateUntil }),
    now,
    rawDir: env.ORDERS_RAW_DIR,
    windowStart: dateFrom,
    windowEnd: dateUntil,
    // issue 269: odkaz priamo na objednávku vo vrátkovej karte na Upozorneniach.
    adminBaseUrl: env.SHOPTET_ADMIN_BASE_URL,
    ...(ordersXmlUrl === undefined
      ? {}
      : { fetchOrderIds: createHttpOrderIdsFetcher({ url: ordersXmlUrl, dateFrom: idsDateFrom, dateUntil }) }),
  });
} finally {
  await pool.end();
}

console.log(popis(result));
console.log(JSON.stringify(result));
if (result.status === "rejected") process.exitCode = 1;
