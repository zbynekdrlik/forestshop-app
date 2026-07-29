import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDb } from "./db/client.js";
import { loadEnv } from "./env.js";
import { createApp } from "./http/app.js";
import { createHttpExportFetcher } from "./modules/catalog/fetcher.js";
import { ingestCatalog } from "./modules/catalog/ingest.js";
import { appVersion } from "./version.js";

const env = loadEnv();
const { db } = createDb(env.DATABASE_URL);

// Migrácie beží aplikácia sama pri štarte — nasadenie tak nemá druhý, samostatne
// zlyhateľný krok. Drizzle spúšťa každú migráciu vo VLASTNEJ transakcii, takže
// databáza nikdy neobslúži polovične-aplikovanú schému — no žiadny advisory lock
// sa pritom nedrží: dva súčasne štartujúce procesy môžu naraz spustiť tú istú DDL
// a jeden z nich zlyhá na kolízii (napr. "already exists"). Nasadenie beží ako
// jedna inštancia (docker-compose.prod.yml), takže to dnes nehrozí.
await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });

// `SHOPTET_EXPORT_URL` je nepovinná (env.ts) — bez nej appka beží ďalej, len
// ručný import vráti 503 (catalog-routes.ts). `exactOptionalPropertyTypes` je
// zapnuté, preto sa `runIngest` do `createApp` odovzdáva ako CHÝBAJÚCI kľúč,
// nikdy ako explicitné `undefined`.
const exportUrl = env.SHOPTET_EXPORT_URL;
const runIngest =
  exportUrl === undefined
    ? undefined
    : (now: Date) =>
        ingestCatalog(db, {
          fetchExport: createHttpExportFetcher({ url: exportUrl }),
          now,
          rawDir: env.CATALOG_RAW_DIR,
        });

const app = createApp(
  db,
  runIngest === undefined
    ? { cookieSecure: env.SESSION_COOKIE_SECURE }
    : { cookieSecure: env.SESSION_COOKIE_SECURE, runIngest },
);

app.use("/*", serveStatic({ root: "./public" }));
app.get("*", serveStatic({ path: "./public/index.html" }));

serve({ fetch: app.fetch, port: env.PORT });
console.log(JSON.stringify({ msg: "api beží", port: env.PORT, version: appVersion() }));
