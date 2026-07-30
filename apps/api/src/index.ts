import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb } from "./db/client.js";
import { loadEnv } from "./env.js";
import { createApp } from "./http/app.js";
import { log } from "./logger.js";
import { createHttpExportFetcher } from "./modules/catalog/fetcher.js";
import { ingestCatalog } from "./modules/catalog/ingest.js";
import { createSmtpMailTransport } from "./modules/mail/transport.js";
import { computeImportWindow, createHttpOrdersExportFetcher } from "./modules/orders/fetcher.js";
import { DEFAULT_ORDERS_IMPORT_WINDOW_DAYS, ingestOrders, type RunOrdersIngest } from "./modules/orders/ingest.js";
import {
  catalogImportJob,
  ordersImportJob,
  pruneRawExportsJob,
  pruneRawOrdersJob,
  sessionCleanupJob,
} from "./modules/scheduler/jobs.js";
import { startScheduler } from "./modules/scheduler/scheduler.js";
import { createShutdownHandler } from "./shutdown.js";
import { appVersion } from "./version.js";

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);

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

// Rovnaká úvaha ako katalógov `runIngest` vyššie: `SHOPTET_ORDERS_URL` je
// nepovinná (env.ts) — bez nej appka beží ďalej, len ručný/nočný import
// objednávok vráti/zaloguje "nenakonfigurované". Okno sa počíta AŽ VNÚTRI
// closure (z `now`, ktoré dostane až v čase behu), nikdy vopred — rovnaká
// disciplína ako `cli/orders-ingest.ts`.
const ordersUrl = env.SHOPTET_ORDERS_URL;
const runOrdersIngest: RunOrdersIngest | undefined =
  ordersUrl === undefined
    ? undefined
    : (now: Date) => {
        const { dateFrom, dateUntil } = computeImportWindow(now, DEFAULT_ORDERS_IMPORT_WINDOW_DAYS);
        return ingestOrders(db, {
          fetchExport: createHttpOrdersExportFetcher({ url: ordersUrl, dateFrom, dateUntil }),
          now,
          rawDir: env.ORDERS_RAW_DIR,
          windowStart: dateFrom,
          windowEnd: dateUntil,
        });
      };

// Odosielanie objednávky dodávateľovi mailom (#31) — rovnaká úvaha ako
// `runIngest`/`runOrdersIngest` vyššie: `MAIL_HOST` je nepovinná (`env.ts`),
// bez nej appka beží ďalej, len odoslanie mailom vráti 503
// (`http/supplier-routes.ts`).
const mailHost = env.MAIL_HOST;
const sendSupplierMail =
  mailHost === undefined
    ? undefined
    : createSmtpMailTransport({
        host: mailHost,
        port: env.MAIL_PORT,
        user: env.MAIL_USER,
        pass: env.MAIL_PASS,
        from: env.MAIL_FROM,
      });

const app = createApp(db, {
  cookieSecure: env.SESSION_COOKIE_SECURE,
  ...(runIngest === undefined ? {} : { runIngest }),
  ...(runOrdersIngest === undefined ? {} : { runOrdersIngest }),
  ...(sendSupplierMail === undefined ? {} : { sendSupplierMail }),
});

// F2 (#12/#3) + F3 (#22/#28): nočný import katalógu/objednávok, mazanie
// starých surových exportov (katalóg aj objednávky) a mazanie expirovaných
// relácií — dnes len ručne spúšťané pre objednávky mimo tohto nočného behu
// cez `POST /api/orders/ingest` (#23). `catalogImportJob`/`ordersImportJob`
// dostávajú svoj `run*Ingest` (môže byť `undefined`, keď zodpovedajúca URL
// nie je nastavená — job to zaznamená ako "failure" s vysvetlením, nikdy sa
// nepreskočí ticho).
const scheduler = startScheduler(db, [
  catalogImportJob(runIngest),
  pruneRawExportsJob(),
  sessionCleanupJob(),
  ordersImportJob(runOrdersIngest),
  pruneRawOrdersJob(env.ORDERS_RAW_DIR),
]);

// `@hono/node-server`'s `serveStatic` prints its OWN `console.error` on every
// call whose `root` doesn't exist — unconditionally, once per process start.
// Outside the production container (tests, e2e, local dev) `./public` never
// exists: e2e serves the frontend from Vite's dev server
// (`apps/web/playwright.config.ts`), integration tests never touch it, and
// local dev normally runs the web app separately too — so that console.error
// fired on every start and every e2e run, training people to ignore it. Guard
// it explicitly and log through the app's own structured logger instead, at a
// severity that matches whether the situation is actually a problem: `debug`
// outside production (expected, not an error) vs `error` in production
// (the build output is genuinely missing — the app cannot serve the frontend
// at all).
const publicDir = "./public";
if (existsSync(publicDir)) {
  app.use("/*", serveStatic({ root: publicDir }));
  app.get("*", serveStatic({ path: `${publicDir}/index.html` }));
} else if (process.env["NODE_ENV"] === "production") {
  log.error({ publicDir }, "produkčný build frontendu chýba — API beží bez servovania webu");
} else {
  log.debug(
    { publicDir },
    "statický adresár webu neexistuje — mimo produkčného kontajnera je to očakávané",
  );
}

const server = serve({ fetch: app.fetch, port: env.PORT });
console.log(JSON.stringify({ msg: "api beží", port: env.PORT, version: appVersion() }));

// issue 78 — plné vysvetlenie prečo toto existuje je v shutdown.ts.
const shutdown = createShutdownHandler({ server, pool, scheduler });
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});
