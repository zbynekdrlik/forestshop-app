import type { Database } from "../../db/client.js";
import { cleanupExpiredSessions } from "../auth/sessions.js";
import type { RunIngest } from "../catalog/ingest.js";
import { pruneRawSnapshots } from "../catalog/raw-store.js";
import { ORDERS_EXPORT_URL_NOT_CONFIGURED, type RunOrdersIngest } from "../orders/ingest.js";
import { pruneRawOrders } from "../orders/raw-prune.js";
import { isPostaUncollectedEnabled } from "../posta-uncollected/settings.js";
import type { PostaUncollectedRunResult } from "../posta-uncollected/run.js";
import { isOrderReminderEnabled } from "../order-reminder/settings.js";
import type { OrderReminderRunResult } from "../order-reminder/run.js";
import type { OrderNoteWritebackRunResult } from "../shoptet-writeback/run-order-note-writeback.js";
import type { WritebackRunResult } from "../shoptet-writeback/run-writeback.js";
import { SUPPLIER_STOCK_JOB_NAME } from "../supplier-stock/constants.js";
import type { SupplierStockRunResult } from "../supplier-stock/run.js";
import type { ScheduledJob } from "./types.js";

export const CATALOG_IMPORT_JOB_NAME = "catalog-import";
export const PRUNE_RAW_EXPORTS_JOB_NAME = "prune-raw-exports";
export const SESSION_CLEANUP_JOB_NAME = "session-cleanup";
export const ORDERS_IMPORT_JOB_NAME = "orders-import";
export const PRUNE_RAW_ORDERS_JOB_NAME = "prune-raw-orders";
export const SHOPTET_WRITEBACK_JOB_NAME = "shoptet-writeback";

// Rovnaká hláška ako `catalogImportJob`/`ordersImportJob` vyššie — operátor
// vidí to isté vysvetlenie, keď SHOPTET_ADMIN_USER/PASSWORD chýbajú.
export const SHOPTET_WRITEBACK_NOT_CONFIGURED =
  "Spätný zápis odkazov na dodávateľa do Shoptetu nie je nakonfigurovaný (chýba SHOPTET_ADMIN_USER/SHOPTET_ADMIN_PASSWORD)";

// Rovnaká hláška ako `catalog-routes.ts`'s 503 pri ručnom importe bez
// nakonfigurovaného SHOPTET_EXPORT_URL — operátor vidí to isté vysvetlenie na
// oboch miestach (ručný pokus aj naplánovaný beh).
const EXPORT_URL_NOT_CONFIGURED = "Import katalógu nie je nakonfigurovaný (chýba SHOPTET_EXPORT_URL)";

/**
 * Import katalógu (issue 184: hodinová kadencia, predtým `daily` 01:00 UTC —
 * majiteľov pôvodný pokyn "sync zo shoptetu ma bezat kazdu hodinu" #115 sa
 * pri zavedení uplatnil len na `ordersImportJob`, katalóg zostal denný).
 * Zmerané na produkcii (posledných 6 denných behov): trvanie 19.5-22.9 s —
 * zanedbateľné aj pri 24 behoch/deň. `:20` je mimo kolízie s ostatnými
 * hodinovými jobmi (`ordersImportJob` :45, `shoptetWritebackJob` :50,
 * `orderNoteWritebackJob` :55) — aspoň 25 min odstup od každého suseda
 * (25 min k `:45`/`:55` predošlej hodiny, 30 min k `:50`). Volá
 * EXISTUJÚCI `runIngest` (index.ts), nič sa nereimplementuje. Bohatý
 * výsledok (accepted/rejected/duplicate) sa aj tak zapíše do
 * `catalog_snapshot` samotným `ingestCatalog` — tento job_run záznam je len
 * scheduler-úrovňová viditeľnosť navyše ("bežal naozaj túto hodinu?"), nie
 * náhrada. Keď `runIngest` nie je nakonfigurované (chýba
 * SHOPTET_EXPORT_URL), job VYHODÍ — scheduler.ts to odchytí a zapíše ako
 * "failure" s touto správou, namiesto toho, aby beh ticho preskočil bez
 * záznamu.
 */
export function catalogImportJob(runIngest: RunIngest | undefined): ScheduledJob {
  return {
    name: CATALOG_IMPORT_JOB_NAME,
    schedule: { kind: "hourly", minuteUtc: 20 },
    async run(_db, now) {
      if (runIngest === undefined) throw new Error(EXPORT_URL_NOT_CONFIGURED);
      const result = await runIngest(now);
      return { detail: result };
    },
  };
}

/**
 * Mazanie surových exportov katalógu — volá existujúci `pruneRawSnapshots`.
 * Retencia skrátená z 30 na 14 dní (issue 184, súčasne so zavedením
 * hodinového `catalogImportJob` vyššie) — `storeRawSnapshot` sa volá LEN keď
 * sa obsah exportu LÍŠI od posledného prijatého (dedup na `contentSha256`,
 * `ingest.ts`), takže hodinová kadencia produkuje WORST CASE 24 nových
 * gzip súborov/deň (~3.7 MB každý na produkcii) namiesto 1 — a `/` na dev2
 * je na 98 % (len ~25 GB voľných, iné projekty na tom istom hostiteľovi).
 * Odvodený katalóg je celý v Postgrese (`pg_dump`-nutý) — surové súbory sú
 * len dôkazový materiál, takže skrátenie retencie nestojí nič a znižuje
 * worst-case peak z ~2.7 GB na ~1.24 GB. `apps/api/src/cli/
 * catalog-prune-raw.ts`'s `KEEP_DAYS` (manuálny/ops vstupný bod, mimo
 * scheduleru) dostal ROVNAKÚ hodnotu, aby oba vstupné body do retencie
 * zostali konzistentné. Schedule (denne 01:15) ostáva NEZMENENÁ — dátumový
 * cutoff odstráni nahromadené staršie súbory bez ohľadu na to, koľko
 * snapshotov medzitým pribudlo, netreba ju spúšťať častejšie.
 */
export function pruneRawExportsJob(keepDays = 14): ScheduledJob {
  return {
    name: PRUNE_RAW_EXPORTS_JOB_NAME,
    schedule: { kind: "daily", hourUtc: 1, minuteUtc: 15 },
    async run(db, now) {
      const result = await pruneRawSnapshots(db, { keepDays, now });
      return { detail: result };
    },
  };
}

/** Mazanie expirovaných relácií (#3) — `DELETE … WHERE expires_at < now()`. */
export function sessionCleanupJob(): ScheduledJob {
  return {
    name: SESSION_CLEANUP_JOB_NAME,
    schedule: { kind: "daily", hourUtc: 1, minuteUtc: 30 },
    async run(db, now) {
      const result = await cleanupExpiredSessions(db, now);
      return { detail: result };
    },
  };
}

/**
 * Import objednávok (#22, hodinová kadencia od #115) — rovnaký vzor ako
 * `catalogImportJob`, volá EXISTUJÚCI `ingestOrders` (cez `runOrdersIngest`
 * closure z `index.ts`), nič sa nereimplementuje. Žiadny nový advisory lock
 * na tejto úrovni — `ingestOrders` (`orders/ingest.ts`) už berie svoj
 * vlastný (`INGEST_ORDERS_ADVISORY_LOCK_KEY`) vnútri seba, presne ako
 * `catalogImportJob` nepridáva zámok navyše. Keď `SHOPTET_ORDERS_URL` nie je
 * nakonfigurované, job VYHODÍ — `scheduler.ts` to zapíše ako "failure" s
 * touto správou, namiesto toho, aby beh ticho preskočil bez záznamu.
 */
export function ordersImportJob(runOrdersIngest: RunOrdersIngest | undefined): ScheduledJob {
  return {
    name: ORDERS_IMPORT_JOB_NAME,
    // #115 (majiteľ: "sync zo shoptetu ma bezat kazdu hodinu"): predtým raz
    // denne o 01:45 (`kind: "daily"`), teraz KAŽDÚ hodinu o :45 — `isDue()`
    // (`scheduler.ts`) periodizuje `hourly` podľa UTC dňa+hodiny, takže sa v
    // tej istej hodine nezopakuje, ale v ĎALŠEJ hodine áno.
    schedule: { kind: "hourly", minuteUtc: 45 },
    async run(_db, now) {
      if (runOrdersIngest === undefined) throw new Error(ORDERS_EXPORT_URL_NOT_CONFIGURED);
      const result = await runOrdersIngest(now);
      return { detail: result };
    },
  };
}

/**
 * Mazanie surových exportov objednávok starších než `keepDays` (#28) — volá
 * existujúci `pruneRawOrders` (čisto súborová retencia, objednávky nemajú
 * snapshotovú tabuľku, na rozdiel od katalógu). Žiadny DB prístup, teda ani
 * žiadny advisory lock.
 */
export function pruneRawOrdersJob(rawDir: string, keepDays = 30): ScheduledJob {
  return {
    name: PRUNE_RAW_ORDERS_JOB_NAME,
    // Zostáva DENNÁ (nie hodinová) — mazanie starých surových exportov
    // netreba spúšťať častejšie. #115: `ordersImportJob` je odteraz hodinová
    // (:45 každú hodinu), takže tento denný beh o 02:00 sa s ním bude
    // prekrývať KAŽDÝ deň (nie len raz), nie iba pri tomto jednom sedení —
    // neprekáža, `pruneRawOrders` nemá žiadny DB advisory zámok (viď komentár
    // vyššie), takže si nekonkuruje.
    schedule: { kind: "daily", hourUtc: 2, minuteUtc: 0 },
    async run(_db, now) {
      const result = await pruneRawOrders(rawDir, { keepDays, now });
      return { detail: result };
    },
  };
}

export type RunShoptetWriteback = (db: Parameters<ScheduledJob["run"]>[0], now: Date) => Promise<WritebackRunResult>;

/**
 * Spätný zápis odkazov na dodávateľa do Shoptetu (issue 122) — hodinovo, na
 * :50 (mimo kolízie s `ordersImportJob`'s :45). Rovnaký vzor ako
 * `catalogImportJob`/`ordersImportJob`: dostáva injektovanú `runWriteback`
 * closure (môže byť `undefined`, keď `SHOPTET_ADMIN_USER`/`PASSWORD` nie sú
 * nakonfigurované — `index.ts` ju zostaví z `runShoptetWriteback`
 * (`shoptet-writeback/run-writeback.ts`) + `shoptetImportConfigFromBaseUrl`),
 * nikdy si business logiku nezostavuje sama. Žiadny nový advisory lock
 * (rovnaký dôvod ako pri tamtých dvoch: v tomto tickete niet manuálneho
 * triggeru, teda niet s čím pretekať — `job_run` periodicita scheduler.ts
 * sama vylučuje duplicitný beh v tej istej hodine). Keď `runWriteback` je
 * `undefined`, job VYHODÍ — rovnaký vzor ako ostatné nepovinne-nakonfigurované
 * joby vyššie.
 */
export function shoptetWritebackJob(runWriteback: RunShoptetWriteback | undefined): ScheduledJob {
  return {
    name: SHOPTET_WRITEBACK_JOB_NAME,
    schedule: { kind: "hourly", minuteUtc: 50 },
    async run(db, now) {
      if (runWriteback === undefined) throw new Error(SHOPTET_WRITEBACK_NOT_CONFIGURED);
      const result = await runWriteback(db, now);
      return { detail: result };
    },
  };
}

export const ORDER_NOTE_WRITEBACK_JOB_NAME = "order-note-writeback";

// Rovnaká hláška ako `shoptetWritebackJob` vyššie — zdieľa tú istú dvojicu
// premenných (`SHOPTET_ADMIN_USER`/`PASSWORD`), operátor vidí to isté
// vysvetlenie na oboch miestach.
export const ORDER_NOTE_WRITEBACK_NOT_CONFIGURED =
  "Spätný zápis poznámky objednávky do Shoptetu nie je nakonfigurovaný (chýba SHOPTET_ADMIN_USER/SHOPTET_ADMIN_PASSWORD)";

export type RunOrderNoteWriteback = (
  db: Parameters<ScheduledJob["run"]>[0],
  now: Date,
) => Promise<OrderNoteWritebackRunResult>;

/**
 * Spätný zápis appkinej poznámky (issue 123) — hodinovo, na `:55` (mimo
 * kolízie s `:45` import objednávok aj `:50` #122's spätný zápis odkazov na
 * dodávateľa). Rovnaký injektovaný-closure vzor ako `shoptetWritebackJob`
 * vyššie: `runOrderNoteWriteback` môže byť `undefined`, keď
 * `SHOPTET_ADMIN_USER`/`PASSWORD` nie sú nakonfigurované (`index.ts`).
 * Žiadny nový advisory lock (rovnaký dôvod ako #122 — v tomto tickete niet
 * manuálneho triggeru, teda niet s čím pretekať).
 */
export function orderNoteWritebackJob(runOrderNoteWriteback: RunOrderNoteWriteback | undefined): ScheduledJob {
  return {
    name: ORDER_NOTE_WRITEBACK_JOB_NAME,
    schedule: { kind: "hourly", minuteUtc: 55 },
    async run(db, now) {
      if (runOrderNoteWriteback === undefined) throw new Error(ORDER_NOTE_WRITEBACK_NOT_CONFIGURED);
      const result = await runOrderNoteWriteback(db, now);
      return { detail: result };
    },
  };
}

export const POSTA_UNCOLLECTED_JOB_NAME = "posta-uncollected";

export type RunPostaUncollected = (db: Database, now: Date) => Promise<PostaUncollectedRunResult>;

/**
 * "Nevyzdvihnuté zásielky" (issue 172) — denne o 09:00 Europe/Bratislava
 * (07:00 UTC — CEST v lete/CET v zime posunie skutočný čas behu o hodinu,
 * rovnaká DST-nevedomá disciplína ako ostatné `daily` joby v tomto súbore;
 * presnosť na hodinu nie je pre túto úlohu kritická). Na rozdiel od
 * `catalogImportJob`/`ordersImportJob` NIE JE `run` nikdy `undefined` — táto
 * automatizácia číta priamo z už importovaných objednávok (žiadna
 * samostatná URL na nakonfigurovanie), a chýbajúce SMTP/BCC rieši
 * `runPostaUncollected` SAMA (per-zásielka, viditeľne v `job_run.detail`),
 * nikdy vyhodením. Tento wrapper kontroluje LEN `enabled` flag PRED behom —
 * "Spustiť teraz" (`http/posta-uncollected-routes.ts`) volá `run` PRIAMO,
 * bez tejto kontroly (návrhový komentár na issue 172: manuálny beh je
 * explicitná ľudská akcia, funguje bez ohľadu na Štart/Stop).
 */
export function postaUncollectedJob(run: RunPostaUncollected): ScheduledJob {
  return {
    name: POSTA_UNCOLLECTED_JOB_NAME,
    schedule: { kind: "daily", hourUtc: 7, minuteUtc: 0 },
    async run(db, now) {
      const enabled = await isPostaUncollectedEnabled(db);
      if (!enabled) {
        return { detail: { skipped: true, reason: "automatizácia je vypnutá (Štart/Stop)" } };
      }
      const result = await run(db, now);
      return { detail: result };
    },
  };
}

export const ORDER_REMINDER_JOB_NAME = "order-reminder";

export type RunOrderReminder = (db: Database, now: Date) => Promise<OrderReminderRunResult>;

/**
 * "Pripomienky objednávok" (issue 173) — denne o 08:00 Europe/Bratislava
 * (06:00 UTC — CEST v lete/CET v zime posunie skutočný čas behu o hodinu,
 * rovnaká DST-nevedomá disciplína ako `postaUncollectedJob`/ostatné `daily`
 * joby vyššie; presnosť na hodinu nie je pre túto úlohu kritická). Rovnaký
 * vzor ako `postaUncollectedJob`: `run` nie je nikdy `undefined` (číta priamo
 * z už importovaných objednávok), chýbajúce OPENAI_API_KEY/MAIL_HOST/BCC rieši
 * `runOrderReminder` SAMA (per-objednávka, viditeľne v `job_run.detail`),
 * nikdy vyhodením. Tento wrapper kontroluje LEN `enabled` flag PRED behom —
 * "Spustiť teraz" aj ručné per-riadkové akcie (`http/order-reminder-routes.ts`)
 * volajú `run`/override PRIAMO, bez tejto kontroly (majiteľov komentár na
 * tickete + návrhový komentár: manuálna akcia je explicitná ľudská akcia).
 */
export function orderReminderJob(run: RunOrderReminder): ScheduledJob {
  return {
    name: ORDER_REMINDER_JOB_NAME,
    schedule: { kind: "daily", hourUtc: 6, minuteUtc: 0 },
    async run(db, now) {
      const enabled = await isOrderReminderEnabled(db);
      if (!enabled) {
        return { detail: { skipped: true, reason: "automatizácia je vypnutá (Štart/Stop)" } };
      }
      const result = await run(db, now);
      return { detail: result };
    },
  };
}

export type RunSupplierStock = (db: Database, now: Date) => Promise<SupplierStockRunResult>;

/**
 * "Dodávateľský sklad" (issue 212) — denne o 04:20 UTC, teda dostatočne PRED
 * automatizáciou prepínania (issue 213), aby tá pracovala s čerstvými dátami
 * z tejto noci, a zároveň mimo `pruneRawExportsJob` (01:15) /
 * `sessionCleanupJob` (01:30) / `pruneRawOrdersJob` (02:00).
 *
 * Žiadny `enabled` prepínač (na rozdiel od `postaUncollectedJob`/
 * `orderReminderJob`): scraper nikam nezapisuje, len číta stránky
 * dodávateľov — chrániť treba až zápis do Shoptetu, ktorý robí issue 213.
 */
export function supplierStockJob(run: RunSupplierStock): ScheduledJob {
  return {
    name: SUPPLIER_STOCK_JOB_NAME,
    schedule: { kind: "daily", hourUtc: 4, minuteUtc: 20 },
    async run(db, now) {
      return { detail: await run(db, now) };
    },
  };
}
