// Ručný import katalógu z príkazového riadka:
//   DATABASE_URL=… SHOPTET_EXPORT_URL=… pnpm catalog:ingest
// Prihlasovací údaj je v `hash` parametri SHOPTET_EXPORT_URL — nikdy sa nevypisuje
// ani neukladá (sourceLabel prechádza cez redactUrl).
//
// Exit kód MUSÍ rozlíšiť prijatý import od odmietnutého — operátor sa spolieha
// na $?, nie len na text výstupu. `duplicate` (rovnaký obsah ako naposledy) je
// úspech (katalóg je aktuálny, len nebolo čo zapisovať), `rejected` je zlyhanie
// (exit 1) s dôvodom v zrozumiteľnej slovenčine.
import { createDb } from "../apps/api/src/db/client.js";
import { loadEnv } from "../apps/api/src/env.js";
import { createHttpExportFetcher } from "../apps/api/src/modules/catalog/fetcher.js";
import { ingestCatalog, type CatalogIngestResult } from "../apps/api/src/modules/catalog/ingest.js";

function popis(result: CatalogIngestResult): string {
  switch (result.status) {
    case "accepted":
      return (
        `Import prijatý: ${String(result.variantCount)} variantov, ` +
        `${String(result.productCount)} produktov, ${String(result.missingCount)} ` +
        `novo chýbajúcich, ${String(result.issueCount)} problémov so záznamami.`
      );
    case "duplicate":
      return "Import preskočený — rovnaký obsah export už bol prijatý skôr, katalóg je aktuálny.";
    case "rejected":
      return `Import odmietnutý: ${result.reason}`;
  }
}

const env = loadEnv();
if (env.SHOPTET_EXPORT_URL === undefined) {
  throw new Error("Chýba SHOPTET_EXPORT_URL — bez adresy exportu sa nedá nič stiahnuť");
}

const { db, pool } = createDb(env.DATABASE_URL);
let result: CatalogIngestResult;
try {
  result = await ingestCatalog(db, {
    fetchExport: createHttpExportFetcher({ url: env.SHOPTET_EXPORT_URL }),
    now: new Date(),
    rawDir: env.CATALOG_RAW_DIR,
  });
} finally {
  await pool.end();
}

console.log(popis(result));
console.log(JSON.stringify(result));
if (result.status === "rejected") process.exitCode = 1;
