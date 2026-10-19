import { createHash } from "node:crypto";
import { and, between, eq, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderLines, orders } from "../../db/schema.js";
import { log } from "../../logger.js";
import { storeRawSnapshot } from "../catalog/raw-store.js";
import { redactSourceLabel, type OrderIdsFetcher } from "./fetcher.js";
import { applyReturnUpozornenia } from "./return-upozornenia.js";
import { applyStuckUpozornenia } from "./stuck-upozornenia.js";
import {
  chunk,
  formatCount,
  ORDERS_INGEST_BATCH_SIZE,
  ORDERS_UNCHANGED_CONSEQUENCE as CONSEQUENCE,
  parseOrdersExport,
  structuralRejectionReason,
  upsertOrdersAndLines,
} from "./ingest-materialize.js";

// Zámok je JEDEN pevný kľúč, NIE odvodený z obsahu — rovnaký dôvod ako
// katalógov `INGEST_ADVISORY_LOCK_KEY` (`catalog/ingest.ts`): serializuje
// VŠETKY súbežné importy objednávok voči tejto databáze. `787_878_003` je
// ĎALŠÍ voľný kľúč v registri `.claude/rules/scheduler.md` — `pg_advisory_lock`/
// `pg_advisory_xact_lock` zdieľajú JEDEN priestor kľúčov bez ohľadu na funkciu,
// takže nikdy nesmie kolidovať s `787_878_001`/`787_878_002`/`787_878_100`.
export const INGEST_ORDERS_ADVISORY_LOCK_KEY = 787_878_003;

// issue 595: dávkovanie, parsovanie aj zápis objednávok žijú v zdieľanom
// `ingest-materialize.ts` (volá ho aj jednorazový doimport `backfill-open.ts`).
export { ORDERS_INGEST_BATCH_SIZE };

export interface OrdersExportDownload {
  readonly body: Buffer;
  readonly sourceLabel: string;
}

export type OrdersExportFetcher = () => Promise<OrdersExportDownload>;

/**
 * `previousLineRatio`: objednávky nemajú (zámerne, #21 návrhový komentár)
 * snapshotovú tabuľku ako katalóg, z ktorej by sa dal odvodiť "posledný
 * prijatý" základ. Namiesto toho sa porovnáva proti tomu, čo je UŽ v databáze
 * pre TO ISTÉ okno (`placedAt` rozsah) — pozri `ingestOrders` nižšie. Pomer
 * 0.2 (20 %) je zámerne benevolentnejší než katalógových 80 % — objem
 * objednávok medzi dvoma po sebe idúcimi nocami bežne kolíše oveľa viac než
 * počet produktov v katalógu (víkendy, sezónnosť), takže prísnejší pomer by
 * zbytočne odmietal legitímne tiché dni. Cieľom je chytiť KATASTROFICKÝ
 * pokles (prázdny/orezaný export pri vypršanom prihlasovacom údaje), nie
 * bežné kolísanie.
 */
export interface OrdersAcceptanceLimits {
  readonly previousLineRatio: number;
}

export const DEFAULT_ORDERS_ACCEPTANCE_LIMITS: OrdersAcceptanceLimits = Object.freeze({
  previousLineRatio: 0.2,
});

export interface OrdersIngestOptions {
  readonly fetchExport: OrdersExportFetcher;
  readonly now: Date;
  readonly rawDir: string;
  // Rovnaké okno, aké fetcher použil na stiahnutie (`computeImportWindow`) —
  // vždy explicitný vstup (rovnaká disciplína ako `now`), nikdy sa neprepočíta
  // nanovo tu, aby sa gate porovnávala presne proti tomu, čo bolo stiahnuté.
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly limits?: OrdersAcceptanceLimits;
  // issue 120: nepovinné BEST-EFFORT obohatenie o interné Shoptet id
  // (`fetcher.ts`'s `createHttpOrderIdsFetcher`) — chýbajúca premenná ALEBO
  // zlyhané stiahnutie NIKDY nesmie spadnúť/odmietnuť celý import objednávok
  // (id je len vylepšenie odkazu do administrácie, nikdy podmienka
  // prijatia dát). Pri zlyhaní sa jednoducho zaloguje varovanie a použije
  // sa prázdna mapa — `COALESCE` v zápise nižšie ochráni predtým zistené id.
  readonly fetchOrderIds?: OrderIdsFetcher;
  // issue 269: základ odkazu do Shoptet administrácie pre kartu na
  // Upozorneniach (`buildShoptetAdminOrderUrl`) — nepovinné, rovnaký vzor
  // ako `http/app.ts`'s `options.adminBaseUrl ?? "https://www.forestshop.sk"`
  // (nikdy natvrdo importovaný `env.ts` priamo do tohto modulu). Chýbajúci
  // v testoch, čo tento zdroj netestujú, je bezpečný — použije sa
  // predvolená verejná adresa appky.
  readonly adminBaseUrl?: string;
}

export type OrdersIngestResult =
  | {
      readonly status: "accepted";
      readonly orderCount: number;
      readonly lineCount: number;
      readonly skippedItemCount: number;
      readonly pseudoItemCount: number;
      readonly issueCount: number;
      // issue 269 (code review, finding 11): počet vrátkových kandidátov
      // preskočených v tomto behu, lebo ich karta je už KONEČNE vybavená
      // (žiadny nevyriešený súrodenec) — rovnaké pomenovanie ako
      // `skippedItemCount` vyššie.
      readonly skippedResolvedReturnCount: number;
      // issue 412: počet `order_line` riadkov zmazaných v tomto behu, lebo
      // ich (objednávka, variant) dvojica z aktuálneho exportu zmizla
      // (produkt bol v Shoptete vymenený/odstránený z už prijatej
      // objednávky) — rovnaké pomenovanie ako `skippedItemCount` vyššie.
      readonly deletedStaleLineCount: number;
      readonly rawPath: string;
    }
  | { readonly status: "rejected"; readonly reason: string; readonly rawPath: string | null };

// Zdieľaný typ medzi `index.ts` (postaví closure z env premennej), `modules/
// scheduler/jobs.ts` (#22) a `http/orders-routes.ts` (#23, ručné tlačidlo
// "stiahnuť teraz") — patrí do `modules/`, nikdy do `http/` (rovnaký dôvod
// ako katalógov `RunIngest`, `.claude/rules/scheduler.md`).
export type RunOrdersIngest = (now: Date) => Promise<OrdersIngestResult>;

// Rovnaká hláška, akú `catalog-routes.ts`/`scheduler/jobs.ts` používajú pre
// chýbajúce `SHOPTET_EXPORT_URL` — zdieľaná JEDNA konštanta (nie kopírovaný
// literál na dvoch miestach), aby sa hláška v `jobs.ts` aj `orders-routes.ts`
// nikdy nerozišla.
export const ORDERS_EXPORT_URL_NOT_CONFIGURED = "Import objednávok nie je nakonfigurovaný (chýba SHOPTET_ORDERS_URL)";

// Posúvajúce sa 90-dňové okno (`fetcher.ts`'s `computeImportWindow`) — jedna
// zdieľaná konštanta namiesto lokálnej `WINDOW_DAYS` duplikovanej v
// `cli/orders-ingest.ts` aj v budúcom scheduler/HTTP volaní (#22/#23).
export const DEFAULT_ORDERS_IMPORT_WINDOW_DAYS = 90;


// issue 120: XML fetch je BEST-EFFORT — samostatná funkcia (nie inline v
// `ingestOrders`), aby chyba tvaru výnimky/rejection nikdy neprepadla mimo
// tohto `try`. Chýbajúca premenná (`fetchOrderIds === undefined`, appka
// bežiaca bez `SHOPTET_ORDERS_XML_URL`) aj zlyhané stiahnutie dopadnú
// rovnako — prázdna mapa + zalogované varovanie, import CSV pokračuje
// úplne nezávisle.
export async function fetchOrderIdsBestEffort(fetchOrderIds: OrderIdsFetcher | undefined): Promise<ReadonlyMap<string, number>> {
  if (fetchOrderIds === undefined) return new Map();
  try {
    return await fetchOrderIds();
  } catch (error) {
    log.warn(
      { errorMessage: error instanceof Error ? error.message : String(error) },
      "nepodarilo sa stiahnuť interné Shoptet id objednávok (XML export) — odkazy na objednávku dočasne zostanú na vyhľadávaní",
    );
    return new Map();
  }
}

export async function ingestOrders(db: Database, options: OrdersIngestOptions): Promise<OrdersIngestResult> {
  const download = await options.fetchExport();
  const orderIdsByCode = await fetchOrderIdsBestEffort(options.fetchOrderIds);
  const byteSize = download.body.byteLength;

  if (byteSize === 0) {
    log.warn(
      { sourceLabel: redactSourceLabel(download.sourceLabel) },
      "export objednávok je prázdny (0 bajtov) — import odmietnutý",
    );
    return { status: "rejected", reason: `Stiahnutý súbor je prázdny (0 bajtov). ${CONSEQUENCE}`, rawPath: null };
  }

  const contentSha256 = createHash("sha256").update(download.body).digest("hex");
  // Surové bajty sa ukladajú PRED parsovaním, nie po ňom — rovnaký dôvod ako
  // katalóg: aj neúspešné parsovanie musí nechať dôkaz na vyšetrenie.
  const rawPath = await storeRawSnapshot(options.rawDir, {
    at: options.now,
    sha256: contentSha256,
    body: download.body,
  });

  // issue 595: parsovanie + zoskupenie (prvý riadok na objednávku vyhráva,
  // sčítanie duplicitného produktu, order-level extra polia z KAŽDÉHO riadku)
  // je zdieľané s doimportom — `ingest-materialize.ts`'s `parseOrdersExport`.
  const parsed = parseOrdersExport(download.body);
  const { orderInfo, lineTotals, allLines, issues, pseudoItemCount, orderExtraByCode } = parsed;

  let result: OrdersIngestResult;
  try {
    result = await db.transaction(async (tx): Promise<OrdersIngestResult> => {
      // Zámok MUSÍ byť prvý príkaz v transakcii — rovnaký dôvod ako katalóg.
      await tx.execute(sql`select pg_advisory_xact_lock(${INGEST_ORDERS_ADVISORY_LOCK_KEY})`);

      // Základ brány prijatia sa číta AŽ TU, hneď po získaní zámku — rovnaký
      // vzor ako katalógov `previousAccepted` (pozri `catalog/ingest.ts`),
      // aby dva súbežné importy nevideli ten istý zastaraný základ.
      const [previousRow] = await tx
        .select({ count: sql<string>`count(*)` })
        .from(orderLines)
        .innerJoin(orders, eq(orderLines.orderId, orders.id))
        .where(between(orders.placedAt, options.windowStart, options.windowEnd));
      const previousLineCount = Number(previousRow?.count ?? "0");

      const limits = options.limits ?? DEFAULT_ORDERS_ACCEPTANCE_LIMITS;
      const usableLineCount = allLines.length;

      let rejectionReason: string | null = structuralRejectionReason(parsed);
      if (rejectionReason === null && previousLineCount > 0) {
        // Trust-on-first-use (rovnaká úvaha ako katalóg): keď pre toto okno
        // ešte nie je v databáze NIČ (previousLineCount === 0), niet voči
        // čomu overiť — prvý import tohto okna sa prijme aj s nula riadkami.
        const floor = Math.floor(previousLineCount * limits.previousLineRatio);
        if (usableLineCount < floor) {
          rejectionReason =
            `Export obsahuje len ${formatCount(usableLineCount, "položku objednávky", "položky objednávok", "položiek objednávok")} za toto obdobie, ` +
            `v databáze je ich už ${String(previousLineCount)} (minimum ${String(floor)}). ${CONSEQUENCE}`;
        }
      }

      if (rejectionReason !== null) {
        log.warn(
          { rejectionReason, usableLineCount, previousLineCount, rawPath },
          "import objednávok odmietnutý — databáza zostáva nezmenená",
        );
        return { status: "rejected", reason: rejectionReason, rawPath };
      }

      // Beží PRED zápisom riadkov (review, issue 595): zachová poradie zamykania
      // `order` → `order_line`, na ktoré sa spolieha poznámka issue 416 nižšie.
      // issue 132: `orderIdsByCode` (best-effort XML fetch, `dateFrom`
      // ROZŠÍRENÝ za predvolené okno cez `backfill.ts`'s `computeOrderIdsWindowStart`
      // — pozri `index.ts`/`cli/orders-ingest.ts`) môže poznať objednávku,
      // ktorá v TOMTO behu CSV vôbec NIE JE. Od #492 sa AJ CSV okno
      // sebaozdravujúco rozširuje (`computeOrdersExportWindowStart`, na
      // NADMNOŽINU XML okna — najstaršia OTVORENÁ objednávka bez ohľadu na id),
      // takže táto vetva je v praxi takmer mŕtva (objednávku, ktorú pozná XML,
      // zvyčajne teraz nesie aj CSV) — ponechaná ZÁMERNE ako obrana pre prípad,
      // že by XML poznal objednávku mimo CSV obsahu (napr. zmazaná/vymenená
      // v CSV, ale ešte v XML histórii). Bez tohto kroku by
      // upsert cyklus nižšie (ktorý ide LEN cez `orderInfo`, postavené z CSV)
      // taký záznam nikdy nenavštívil, takže jeho `shoptetOrderId` by sa
      // nikdy nezapísal, hoci XML mapa ho pozná. Priamy `UPDATE` namiesto
      // upsertu — objednávka MUSÍ už v DB existovať (z predošlého importu),
      // tento krok jej nikdy nezakladá nový riadok len z XML dát (tie
      // nenesú `customerName` ani ostatné povinné polia). `COALESCE` chráni
      // už zistené id rovnako ako hlavný upsert nižšie.
      for (const [externalOrderId, shoptetOrderId] of orderIdsByCode) {
        if (orderInfo.has(externalOrderId)) continue;
        await tx
          .update(orders)
          .set({ shoptetOrderId: sql`coalesce(${orders.shoptetOrderId}, ${shoptetOrderId})` })
          .where(eq(orders.externalOrderId, externalOrderId));
      }

      // issue 595: zápis objednávok + riadkov (COALESCE polia, `comment`/`state`
      // mimo `set`, preskočenie neznámeho variantu) je zdieľaný s doimportom —
      // plné odôvodnenie každého poľa je pri `upsertOrdersAndLines`
      // (`ingest-materialize.ts`).
      const { orderIdByExternalId, insertedLineCount, skippedItemCount } = await upsertOrdersAndLines(tx, {
        orderInfo,
        orderExtraByCode,
        orderIdsByCode,
        lines: allLines,
      });

      // issue 412: zosúladenie riadkov EXISTUJÚCEJ objednávky s AKTUÁLNYM
      // exportom — Shoptet dovolí zmeniť produkt na už prijatej objednávke
      // (vymeniť itemCode, nie len upraviť množstvo). Upsert vyššie NOVÝ
      // produkt vždy pridá (INSERT vetva ON CONFLICT), ale bez tohto kroku
      // by STARÝ riadok (produkt, ktorý Shoptet už nehlási) navždy zostal v
      // DB — presne bug #412 (objednávka 20261306 stále ukazovala dávno
      // vymenený produkt). Rozsah je PRESNE tento beh: mažú sa LEN riadky
      // objednávok, ktoré TENTO import naozaj spracoval
      // (`orderIdByExternalId`), a LEN tie (objednávka, variant) dvojice,
      // ktoré TENTO export už vôbec nehlási (`lineTotals` — surová množina,
      // PRED filtrom na známy variant, aby sa nezmazal legitímny existujúci
      // riadok len preto, že katalógové overenie preň v tomto behu
      // zlyhalo). Riadky objednávok MIMO tohto behu (staršie než okno,
      // alebo objednávka bez jediného reálneho produktu v tomto behu) sa
      // vôbec nedotýkajú — nie sú v `orderIdByExternalId`.
      //
      // FK prieskum (design komentár na tickete): NIČ v appke nemá cudzí
      // kľúč na `order_line.id` ani na dvojicu (order_id, variant_code) —
      // pripomienky (`order_reminder_state`, kľúč `order_code`), DPD
      // zásielky (`dpd_shipment`, kľúč `order_id`), dodávateľské odkazy
      // (`product_supplier_override`/`product_supplier_link_override`,
      // kľúč `product_key`) a Zlúčenie objednávok (číta LEN `order`, žiadny
      // JOIN na `order_line`) prežijú zmazanie bez zmeny. `audit_events.
      // entity_id` je prostý text bez FK. Frontendov `lineId` je len
      // dočasný stav v pamäti prehliadača — súbežný zápis na medzičasom
      // zmazaný riadok narazí na už existujúcu "not_found" vetvu
      // (`state.ts`), rovnaká neškodná zhoda ako pri akejkoľvek inej
      // súbežnej úprave.
      //
      // Poradie zamykania (code review, issue 416): táto transakcia drží
      // `order` riadky zamknuté už od hlavného upsertu vyššie a TERAZ
      // navyše zamyká `order_line` riadky — teoreticky sa to môže stretnúť
      // s `queries.ts`'s `listOpenOrderLineIdsForSupplier`'s `.for("update",
      // { of: [orderLines, orders] })` (`setSupplierLinesOrdered`, hromadné
      // "objednané" na celú skupinu dodávateľa), ktorý OBE tabuľky zamyká v
      // poradí, aké si zvolí Postgres-ov plánovač JOINu — teoreticky
      // opačnom (AB-BA cyklus). Toto NIE JE nová trieda rizika zavedená
      // TÝMTO krokom — presne to isté poradie (`order` → `order_line`) už
      // roky drží existujúci upsert cyklus vyššie v TEJ istej transakcii;
      // tento krok len pridáva ĎALŠIE dotyky `order_line`. Postgres-ov
      // deadlock detektor takú kolíziu bezpečne vyrieši (jedna strana sa
      // abortne, žiadne poškodené dáta) — import sa zopakuje o 15 min (issue 589),
      // manažérov klik dostane chybu a smie ho zopakovať. Vyhradený
      // deterministický regresný test tejto interakcie je #416 (presahuje
      // rozsah tohto bugfixu — concurrency analýza naprieč dvomi inak
      // nezávislými modulmi).
      //
      // Dávkovaný (nie po jednej objednávke) set-based DELETE — rovnaký
      // dôvod ako `chunk()` batching všade inde v tomto súbore (menej
      // round-tripov) a NAVYŠE skracuje okno, počas ktorého táto
      // transakcia drží `order_line` zámky (relevantné pre poradie
      // zamykania vyššie). Čisto drizzle query builder (`and`/`or`/
      // `notInArray`), žiadny raw `sql` VALUES trik — `database.md`'s
      // vlastná skúsenosť (`\s` escape past v `sql` šablóne) je presne
      // dôvod, prečo sa tu radšej nezavádza nový raw-SQL vzor, keď
      // existujúci query builder to isté vyjadrí bezpečne.
      let deletedStaleLineCount = 0;
      for (const batch of chunk([...orderIdByExternalId.entries()], ORDERS_INGEST_BATCH_SIZE)) {
        const conditions = batch
          .map(([externalOrderId, orderId]) => {
            const byVariant = lineTotals.get(externalOrderId);
            // Nemôže nastať v praxi (`orderIdByExternalId` aj `lineTotals`
            // sa plnia z toho istého `candidates` prechodu vyššie) —
            // defenzívne, aby prípadný budúci refaktor tento predpoklad
            // nikdy ticho neporušil zmazaním všetkých riadkov objednávky.
            if (byVariant === undefined || byVariant.size === 0) return undefined;
            return and(eq(orderLines.orderId, orderId), notInArray(orderLines.variantCode, [...byVariant.keys()]));
          })
          .filter((condition) => condition !== undefined);
        if (conditions.length === 0) continue;
        const deleted = await tx.delete(orderLines).where(or(...conditions)).returning({ id: orderLines.id });
        deletedStaleLineCount += deleted.length;
      }

      // issue 269/297: druhý automatický zdroj pre nástenku Upozornenia
      // (#267) — plná logika (AKTÍVNY vrátkový stav zakladá/obnoví kartu,
      // HOTOVÝ ju automaticky zatvorí) vyčlenená do `return-upozornenia.ts`
      // (eslint `max-lines: 400`, `.claude/rules/testing.md`) — čítaj JEJ
      // vlastné komentáre pre plné odôvodnenie (dedup na objednávku,
      // `.for("update")` pre-check, prečo beží až TESNE PRED commitom).
      const adminBaseUrl = options.adminBaseUrl ?? "https://www.forestshop.sk";
      const { skippedResolvedReturnCount, autoResolvedFinishedReturnCount } = await applyReturnUpozornenia({
        tx,
        orderInfo,
        orderIdsByCode,
        adminBaseUrl,
        now: options.now,
        batchSize: ORDERS_INGEST_BATCH_SIZE,
      });

      // issue 301: štvrtý automatický zdroj pre Upozornenia — objednávka, čo
      // dlho visí v nevybavenom stave (`stuck-upozornenia.ts`'s vlastné
      // komentáre nesú plné odôvodnenie).
      const { stuckOrderCount, autoResolvedStuckOrderCount } = await applyStuckUpozornenia({
        tx,
        orderInfo,
        orderIdsByCode,
        adminBaseUrl,
        now: options.now,
      });

      log.info(
        {
          orderCount: orderInfo.size,
          lineCount: insertedLineCount,
          skippedItemCount,
          pseudoItemCount,
          issueCount: issues.length,
          skippedResolvedReturnCount,
          autoResolvedFinishedReturnCount,
          stuckOrderCount,
          autoResolvedStuckOrderCount,
          deletedStaleLineCount,
        },
        "objednávky naimportované",
      );

      return {
        status: "accepted",
        orderCount: orderInfo.size,
        lineCount: insertedLineCount,
        skippedItemCount,
        pseudoItemCount,
        issueCount: issues.length,
        skippedResolvedReturnCount,
        deletedStaleLineCount,
        rawPath,
      };
    });
  } catch (error) {
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    log.error(
      { contentSha256, rawPath, rawErrorMessage },
      "materializácia objednávok zlyhala — surový export ostáva na disku ako dôkaz",
    );
    throw error;
  }
  return result;
}
