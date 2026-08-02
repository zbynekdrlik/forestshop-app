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
import { computeOrderIdsWindowStart } from "./modules/orders/backfill.js";
import { computeImportWindow, createHttpOrderIdsFetcher, createHttpOrdersExportFetcher } from "./modules/orders/fetcher.js";
import { DEFAULT_ORDERS_IMPORT_WINDOW_DAYS, ingestOrders, type RunOrdersIngest } from "./modules/orders/ingest.js";
import { createHttpTrackingClient } from "./modules/posta-uncollected/tracking-client.js";
import { runPostaUncollected } from "./modules/posta-uncollected/run.js";
import { createOpenAiClassifyClient } from "./modules/order-reminder/classify-client.js";
import { runOrderReminder } from "./modules/order-reminder/run.js";
import {
  catalogImportJob,
  ordersImportJob,
  orderNoteWritebackJob,
  orderReminderJob,
  postaUncollectedJob,
  pruneRawExportsJob,
  pruneRawOrdersJob,
  sessionCleanupJob,
  shoptetWritebackJob,
} from "./modules/scheduler/jobs.js";
import { startScheduler } from "./modules/scheduler/scheduler.js";
import { orderNoteWritebackConfigFromBaseUrl, shoptetImportConfigFromBaseUrl } from "./modules/shoptet-writeback/config.js";
import { runOrderNoteWritebackJob } from "./modules/shoptet-writeback/run-order-note-writeback.js";
import { runShoptetWriteback } from "./modules/shoptet-writeback/run-writeback.js";
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
// issue 120: druhý, nepovinný export — jediný zdroj interného Shoptet id.
// Chýbajúca premenná necháva `fetchOrderIds` úplne mimo `ingestOrders`
// volania (`exactOptionalPropertyTypes`, rovnaká disciplína ako
// `runIngest`/`runOrdersIngest` vyššie) — `ingestOrders` to sama osebe berie
// ako "id zatiaľ neznáme", nikdy ako chybu.
const ordersXmlUrl = env.SHOPTET_ORDERS_XML_URL;
// issue 132: XML id-fetch okno (LEN preň, nikdy pre hlavný CSV import vyššie
// — ten má vlastnú, nezávislú akceptančnú logiku, `.claude/rules/orders.md`)
// sa sebaozdravujúco predĺži dozadu, keď v DB existuje otvorená objednávka
// bez `shoptet_order_id` staršia než predvolené 90-dňové okno
// (`backfill.ts`'s `computeOrderIdsWindowStart`) — inak taká objednávka
// (napr. 20260739/20260740) nikdy nedostane svoje id, hoci Shoptet ho má a
// objednávka ostáva otvorená.
const runOrdersIngest: RunOrdersIngest | undefined =
  ordersUrl === undefined
    ? undefined
    : async (now: Date) => {
        const { dateFrom, dateUntil } = computeImportWindow(now, DEFAULT_ORDERS_IMPORT_WINDOW_DAYS);
        const idsDateFrom = ordersXmlUrl === undefined ? dateFrom : await computeOrderIdsWindowStart(db, dateFrom);
        return ingestOrders(db, {
          fetchExport: createHttpOrdersExportFetcher({ url: ordersUrl, dateFrom, dateUntil }),
          now,
          rawDir: env.ORDERS_RAW_DIR,
          windowStart: dateFrom,
          windowEnd: dateUntil,
          ...(ordersXmlUrl === undefined
            ? {}
            : { fetchOrderIds: createHttpOrderIdsFetcher({ url: ordersXmlUrl, dateFrom: idsDateFrom, dateUntil }) }),
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

// issue 122: spätný zápis odkazu na dodávateľa do Shoptetu — rovnaká úvaha
// ako `runIngest`/`runOrdersIngest`/`sendSupplierMail` vyššie:
// `SHOPTET_ADMIN_USER`/`PASSWORD` sú nepovinné (`env.ts`), appka beží ďalej
// bez nich, len naplánovaná úloha zaznamená "nenakonfigurované"
// (`scheduler/jobs.ts`'s `shoptetWritebackJob`). Žiadna HTTP cesta ich
// nepotrebuje (na rozdiel od tamtých troch) — toto je LEN scheduler.
const shoptetAdminUser = env.SHOPTET_ADMIN_USER;
const shoptetAdminPassword = env.SHOPTET_ADMIN_PASSWORD;
const runShoptetWritebackFn =
  shoptetAdminUser === undefined || shoptetAdminPassword === undefined
    ? undefined
    : (db2: typeof db, now: Date) =>
        runShoptetWriteback(
          db2,
          shoptetImportConfigFromBaseUrl(env.SHOPTET_ADMIN_BASE_URL, shoptetAdminUser, shoptetAdminPassword),
          now,
        );

// issue 123: spätný zápis appkinej poznámky k objednávke — zdieľa TIE ISTÉ
// nepovinné premenné ako #122 vyššie (žiadne nové), len iná Playwright
// automatizácia (per-objednávka, nie hromadný CSV import).
const runOrderNoteWritebackFn =
  shoptetAdminUser === undefined || shoptetAdminPassword === undefined
    ? undefined
    : (db2: typeof db, now: Date) =>
        runOrderNoteWritebackJob(
          db2,
          orderNoteWritebackConfigFromBaseUrl(env.SHOPTET_ADMIN_BASE_URL, shoptetAdminUser, shoptetAdminPassword),
          now,
        );

// issue 172: "Nevyzdvihnuté zásielky" — tracking klient je VŽDY reálny
// (žiadna URL na nakonfigurovanie, tretia strana má fixnú adresu,
// `constants.ts`); mail transport a BCC adresa môžu chýbať (rovnaká úvaha
// ako `sendSupplierMail` vyššie) — `runPostaUncollected` to sama rieši
// fail-closed (nikdy nepošle bez oboch), nikdy nevyhadzuje.
const postaUncollectedDeps = {
  trackingClient: createHttpTrackingClient(),
  mailTransport: sendSupplierMail,
  bccEmail: env.POSTA_UNCOLLECTED_BCC_EMAIL,
  adminBaseUrl: env.SHOPTET_ADMIN_BASE_URL,
};

// issue 173: "Pripomienky objednávok" — rovnaká úvaha ako #172 vyššie: mail
// transport (zdieľaný `sendSupplierMail`, rovnaká SMTP infraštruktúra) a BCC
// adresa môžu chýbať, `runOrderReminder` to sama rieši fail-closed. AI
// klasifikátor je NOVÝ, nezávislý nepovinný závislosť — `OPENAI_API_KEY`
// chýbajúci = `classifyClient` je `undefined`, automatizácia to zobrazí ako
// "čaká" (AI nedostupné), nikdy nehádaj/nepošle naslepo.
const openAiApiKey = env.OPENAI_API_KEY;
const orderReminderDeps = {
  classifyClient: openAiApiKey === undefined ? undefined : createOpenAiClassifyClient({ apiKey: openAiApiKey }),
  mailTransport: sendSupplierMail,
  bccEmail: env.ORDER_REMINDER_BCC_EMAIL,
  adminBaseUrl: env.SHOPTET_ADMIN_BASE_URL,
};

// issue 176: "Nedostupné tovary" — rovnaká úvaha ako #172/#173 vyššie: mail
// transport (zdieľaný `sendSupplierMail`) a BCC adresa môžu chýbať,
// `sendNedostupneEmail` to sama rieši fail-closed. ŽIADNY `classifyClient`
// (na rozdiel od #173) — táto automatizácia nemá AI klasifikáciu, e-mail
// vždy posiela človek ručne po povinnom náhľade.
const nedostupneDeps = {
  mailTransport: sendSupplierMail,
  bccEmail: env.NEDOSTUPNE_BCC_EMAIL,
  adminBaseUrl: env.SHOPTET_ADMIN_BASE_URL,
};

const app = createApp(db, {
  cookieSecure: env.SESSION_COOKIE_SECURE,
  ...(runIngest === undefined ? {} : { runIngest }),
  ...(runOrdersIngest === undefined ? {} : { runOrdersIngest }),
  ...(sendSupplierMail === undefined ? {} : { sendSupplierMail }),
  adminBaseUrl: env.SHOPTET_ADMIN_BASE_URL,
  postaUncollected: postaUncollectedDeps,
  orderReminder: orderReminderDeps,
  nedostupne: nedostupneDeps,
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
  shoptetWritebackJob(runShoptetWritebackFn),
  orderNoteWritebackJob(runOrderNoteWritebackFn),
  postaUncollectedJob((db2, now) => runPostaUncollected({ db: db2, now, ...postaUncollectedDeps })),
  orderReminderJob((db2, now) => runOrderReminder({ db: db2, now, ...orderReminderDeps })),
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
