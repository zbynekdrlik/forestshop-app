import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb } from "./db/client.js";
import { loadEnv } from "./env.js";
import { createApp } from "./http/app.js";
import { log } from "./logger.js";
import { createHttpIcsFetcher } from "./modules/calendar/fetcher.js";
import { createNextEventService } from "./modules/calendar/service.js";
import { createHttpExportFetcher } from "./modules/catalog/fetcher.js";
import { ingestCatalog } from "./modules/catalog/ingest.js";
import { createSmtpMailTransport } from "./modules/mail/transport.js";
import { computeOrdersIngestWindows } from "./modules/orders/backfill.js";
import { createHttpOrderIdsFetcher, createHttpOrdersExportFetcher } from "./modules/orders/fetcher.js";
import { ingestOrders, type RunOrdersIngest } from "./modules/orders/ingest.js";
import { createHttpTrackingClient } from "./modules/posta-uncollected/tracking-client.js";
import { runPostaUncollected } from "./modules/posta-uncollected/run.js";
import { createOpenAiClassifyClient } from "./modules/order-reminder/classify-client.js";
import { runOrderReminder } from "./modules/order-reminder/run.js";
import {
  catalogImportJob,
  ordersImportJob,
  orderNoteWritebackJob,
  orderReminderJob,
  pairingSearchJob,
  shopFeedJob,
  shopSitemapJob,
  supplierStockJob,
  restockJob,
  postaUncollectedJob,
  pruneRawExportsJob,
  pruneRawOrdersJob,
  sessionCleanupJob,
  shoptetWritebackJob,
} from "./modules/scheduler/jobs.js";
import { runPairingSearch } from "./modules/pairing-search/run.js";
import { DEFAULT_SHOP_FEED_URL } from "./modules/shop-feed/constants.js";
import { createHttpShopFeedFetcher } from "./modules/shop-feed/fetcher.js";
import { runShopFeed } from "./modules/shop-feed/run.js";
import { runShopSitemap } from "./modules/shop-sitemap/run.js";
import { fetchSupplierPage } from "./modules/supplier-stock/page-fetcher.js";
import { runSupplierStock } from "./modules/supplier-stock/run.js";
import { runRestock } from "./modules/restock/run.js";
import { startScheduler } from "./modules/scheduler/scheduler.js";
import { orderNoteWritebackConfigFromBaseUrl, shoptetImportConfigFromBaseUrl } from "./modules/shoptet-writeback/config.js";
import { dpdPortalConfigFromBaseUrl } from "./modules/dpd/config.js";
import { runOrderNoteWritebackJob } from "./modules/shoptet-writeback/run-order-note-writeback.js";
import { runShoptetWritebackSequence } from "./modules/shoptet-writeback/run-writeback-sequence.js";
import { cleanOrphanedJobRuns } from "./modules/scheduler/startup-cleanup.js";
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

// issue 413: osirotené `job_run` riadky (predošlý reštart/deploy zabil
// rozbehnutý beh, `status='running'` ostal navždy) sa vyčistia HNEĎ TU —
// PRED `createApp`/`startScheduler`/`serve()`, takže ešte NIKTO nemohol
// vložiť NOVÝ "running" riadok (žiadny race s čerstvo vloženým riadkom).
await cleanOrphanedJobRuns(db, new Date());

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
// issue 132/492: obe importné okná sa sebaozdravujúco predĺžia dozadu, keď v
// DB existuje otvorená objednávka staršia než predvolené 90-dňové okno. CSV
// import (`exportDateFrom`, #492) na najstaršiu OTVORENÚ objednávku BEZ ohľadu
// na id — inak jej `status_name` navždy zamrzne (objednávka vybavená v Shoptete
// AŽ PO vypadnutí z okna zostane v appke "Vybavuje sa" a visí v "Na objednanie",
// napr. 20260739; CSV je jediná cesta osviežujúca status). XML id-fetch
// (`idsDateFrom`, #132) na najstaršiu otvorenú BEZ `shoptet_order_id`, z
// predvoleného okna (nezmenené #132). Oba počíta JEDEN zdroj pravdy
// `computeOrdersIngestWindows` (`backfill.ts`) — zdieľaný s `cli/orders-ingest.ts`.
const runOrdersIngest: RunOrdersIngest | undefined =
  ordersUrl === undefined
    ? undefined
    : async (now: Date) => {
        const { exportDateFrom, idsDateFrom, dateUntil } = await computeOrdersIngestWindows(db, now, {
          hasXmlUrl: ordersXmlUrl !== undefined,
        });
        return ingestOrders(db, {
          fetchExport: createHttpOrdersExportFetcher({ url: ordersUrl, dateFrom: exportDateFrom, dateUntil }),
          now,
          rawDir: env.ORDERS_RAW_DIR,
          windowStart: exportDateFrom,
          windowEnd: dateUntil,
          // issue 269: odkaz priamo na objednávku vo vrátkovej karte na
          // Upozorneniach — rovnaká premenná ako `postaUncollectedDeps`/
          // `orderReminderDeps`/`nedostupneDeps` nižšie.
          adminBaseUrl: env.SHOPTET_ADMIN_BASE_URL,
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
        // issue 358: nezávislá od `from` — pozri `env.ts`/`transport.ts`.
        replyTo: env.MAIL_REPLY_TO,
      });

// issue 122 + issue 387 E7: spätný zápis do Shoptetu — rovnaká úvaha ako
// `runIngest`/`runOrdersIngest`/`sendSupplierMail` vyššie:
// `SHOPTET_ADMIN_USER`/`PASSWORD` sú nepovinné (`env.ts`), appka beží ďalej
// bez nich, len naplánovaná úloha zaznamená "nenakonfigurované"
// (`scheduler/jobs.ts`'s `shoptetWritebackJob`). Žiadna HTTP cesta ich
// nepotrebuje (na rozdiel od tamtých troch) — toto je LEN scheduler.
// E7: `runShoptetWritebackSequence` robí OBIDVA podbehy (linkový + stavový,
// ten druhý gatovaný vlastným Štart/Stop prepínačom) s TÝMITO ISTÝMI
// prihlasovacími údajmi — žiadne nové premenné.
const shoptetAdminUser = env.SHOPTET_ADMIN_USER;
const shoptetAdminPassword = env.SHOPTET_ADMIN_PASSWORD;
const runShoptetWritebackFn =
  shoptetAdminUser === undefined || shoptetAdminPassword === undefined
    ? undefined
    : (db2: typeof db, now: Date) =>
        runShoptetWritebackSequence(
          db2,
          shoptetImportConfigFromBaseUrl(env.SHOPTET_ADMIN_BASE_URL, shoptetAdminUser, shoptetAdminPassword),
          now,
        );

// issue 213: prepínanie vypredaných produktov späť na "Skladom" — zdieľa TIE
// ISTÉ prihlasovacie údaje ako #122/#123. Bez nich sa job vôbec nezostaví a
// `restockJob` zapíše zlyhanie namiesto tichého preskočenia.
const runRestockFn =
  shoptetAdminUser === undefined || shoptetAdminPassword === undefined
    ? undefined
    : (db2: typeof db, now: Date) =>
        runRestock({
          db: db2,
          now,
          config: shoptetImportConfigFromBaseUrl(env.SHOPTET_ADMIN_BASE_URL, shoptetAdminUser, shoptetAdminPassword),
        });

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

// issue 257: "Zlúčenie objednávok" — rovnaká úvaha ako `nedostupneDeps`
// vyššie: zdieľaný `sendSupplierMail`, vlastná fail-closed BCC premenná,
// žiadny `classifyClient` (žiadna AI klasifikácia, e-mail posiela človek
// ručne po povinnom náhľade).
const orderMergeDeps = {
  mailTransport: sendSupplierMail,
  bccEmail: env.ORDER_MERGE_BCC_EMAIL,
};

// issue 292: "Eshop → Preprava DPD" — vlastné prihlasovacie údaje
// (`DPD_PORTAL_USER`/`PASSWORD`), nezdieľané so Shoptet-om.
// `config: undefined` = appka beží ďalej, akcie odosielajúce do DPD vrátia
// 503 "nenakonfigurované" (fail-closed, `http/dpd-routes.ts`).
const dpdUser = env.DPD_PORTAL_USER;
const dpdPassword = env.DPD_PORTAL_PASSWORD;
const dpdDeps = {
  config: dpdUser === undefined || dpdPassword === undefined ? undefined : dpdPortalConfigFromBaseUrl(env.DPD_PORTAL_BASE_URL, dpdUser, dpdPassword),
};

// issue 309/469: "Eshop → Upozornenia" — najbližšie udalosti z majiteľových
// Google kalendárov. `GOOGLE_CALENDAR_ICS_URL` je nepovinná (env.ts) — bez nej
// appka beží ďalej, karta na nástenke sa jednoducho nezobrazí (`http/app.ts`'s
// `nextEvent === undefined` vetva). issue 469: premenná môže obsahovať VIAC
// adries (env.ts ich už rozdelí na pole) — jeden bounded fetcher per adresa.
const googleCalendarIcsUrls = env.GOOGLE_CALENDAR_ICS_URL;
const nextEventService =
  googleCalendarIcsUrls === undefined ? undefined : createNextEventService(googleCalendarIcsUrls.map((url) => createHttpIcsFetcher(url)));

// issue 319: chýbajúci kľúč tu (na rozdiel od `postaUncollected`/
// `orderReminder`/`nedostupne`/`orderMerge`/`dpd` nižšie) nechával
// `registerRestockRoutes` (`http/app.ts`) vždy padnúť na jeho fail-closed
// fallback (prázdne prihlasovacie údaje) — manuálne "Spustiť teraz" tak v
// produkcii vždy zlyhalo na prihlásení do Shoptetu, hoci `runRestockFn`
// vyššie (pre naplánovaný nočný beh) má tie isté reálne premenné správne
// zostavené. `?? ""` mimo prítomnosti premenných zachováva presne to isté
// fail-closed správanie, aké `app.ts`'s fallback mal dovtedy sám.
const app = createApp(db, {
  cookieSecure: env.SESSION_COOKIE_SECURE,
  ...(runIngest === undefined ? {} : { runIngest }),
  ...(runOrdersIngest === undefined ? {} : { runOrdersIngest }),
  ...(sendSupplierMail === undefined ? {} : { sendSupplierMail }),
  adminBaseUrl: env.SHOPTET_ADMIN_BASE_URL,
  postaUncollected: postaUncollectedDeps,
  orderReminder: orderReminderDeps,
  nedostupne: nedostupneDeps,
  orderMerge: orderMergeDeps,
  fetchSupplierPage,
  restock: { config: shoptetImportConfigFromBaseUrl(env.SHOPTET_ADMIN_BASE_URL, shoptetAdminUser ?? "", shoptetAdminPassword ?? "") },
  dpd: dpdDeps,
  ...(nextEventService === undefined ? {} : { nextEvent: nextEventService }),
});

// F2 (#12/#3) + F3 (#22/#28): nočný import katalógu/objednávok, mazanie
// starých surových exportov (katalóg aj objednávky) a mazanie expirovaných
// relácií — dnes len ručne spúšťané pre objednávky mimo tohto nočného behu
// cez `POST /api/orders/ingest` (#23). `catalogImportJob`/`ordersImportJob`
// dostávajú svoj `run*Ingest` (môže byť `undefined`, keď zodpovedajúca URL
// nie je nastavená — job to zaznamená ako "failure" s vysvetlením, nikdy sa
// nepreskočí ticho).
// Adresa feedu je verejná (nenesie prihlasovací údaj), takže má rozumnú
// predvolenú hodnotu v kóde — premenná prostredia je len poistka pre prípad,
// že by Shoptet adresu zmenil.
const fetchShopFeed = createHttpShopFeedFetcher(env.SHOP_FEED_URL ?? DEFAULT_SHOP_FEED_URL);

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
  shopFeedJob((db2, now) => runShopFeed({ db: db2, now, fetchFeed: fetchShopFeed })),
  shopSitemapJob((db2, now) => runShopSitemap({ db: db2, now })),
  supplierStockJob((db2, now) => runSupplierStock({ db: db2, now, fetchPage: fetchSupplierPage })),
  restockJob(runRestockFn),
  // issue 387 E3: žiadne prihlasovacie údaje potrebné (verejné vyhľadávacie
  // stránky dodávateľov) — na rozdiel od `restockJob`/`shoptetWritebackJob`
  // vyššie sa `run` tu nikdy nezostavuje ako `undefined`. Automatika je
  // napriek tomu default VYPNUTÁ (`pairing_search_settings.enabled`) —
  // `pairingSearchJob`'s vlastná kontrola pred behom, nie chýbajúca konfigurácia.
  pairingSearchJob((db2, now) => runPairingSearch({ db: db2, now })),
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
