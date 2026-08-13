import { createHash } from "node:crypto";
import { and, between, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderLines, orders, variants } from "../../db/schema.js";
import { log } from "../../logger.js";
import { storeRawSnapshot } from "../catalog/raw-store.js";
import { redactSourceLabel, type OrderIdsFetcher } from "./fetcher.js";
import {
  decodeCp1250,
  EMPTY_ORDER_LEVEL_EXTRA,
  extractOrderLevelExtra,
  mapOrderRow,
  mergeOrderLevelExtra,
  parseDelimited,
  REQUIRED_ORDER_COLUMNS,
  type OrderLevelExtra,
  type OrderLineCandidate,
  type OrderRowIssue,
} from "./parser.js";
import { applyReturnUpozornenia } from "./return-upozornenia.js";
import { applyStuckUpozornenia } from "./stuck-upozornenia.js";

// Zámok je JEDEN pevný kľúč, NIE odvodený z obsahu — rovnaký dôvod ako
// katalógov `INGEST_ADVISORY_LOCK_KEY` (`catalog/ingest.ts`): serializuje
// VŠETKY súbežné importy objednávok voči tejto databáze. `787_878_003` je
// ĎALŠÍ voľný kľúč v registri `.claude/rules/scheduler.md` — `pg_advisory_lock`/
// `pg_advisory_xact_lock` zdieľajú JEDEN priestor kľúčov bez ohľadu na funkciu,
// takže nikdy nesmie kolidovať s `787_878_001`/`787_878_002`/`787_878_100`.
export const INGEST_ORDERS_ADVISORY_LOCK_KEY = 787_878_003;

// Rovnaký dôvod ako katalóg's `INGEST_BATCH_SIZE`: veľký INSERT narazí na
// limit 65 535 parametrov na príkaz v protokole Postgresu. 90-dňové okno má
// rádovo stovky objednávok/riadkov, takže toto v praxi znamená jednu dávku —
// hodnota je tu pre bezpečnosť, keby sa okno niekedy rozšírilo.
export const ORDERS_INGEST_BATCH_SIZE = 500;

const CONSEQUENCE = "Objednávky zostávajú nezmenené, import môžete kedykoľvek zopakovať.";

/**
 * Slovenská číselná zhoda pre "riadok"/"položka" — rovnaký vzor ako
 * `catalog/validation.ts`'s `formatMalformedRows`: 1 → jednotné číslo, LITERÁLNE
 * 2/3/4 → málopočetné (paucal), všetko ostatné (0, 5+, aj 22/23/24…) → rodový
 * pád množného čísla — slovenčina (na rozdiel od ruštiny/poľštiny) neodvodzuje
 * tvar z poslednej číslice, takže 22 berie rovnaký tvar ako 21 alebo 25.
 */
function formatCount(n: number, one: string, few: string, many: string): string {
  if (n === 1) return `1 ${one}`;
  if (n === 2 || n === 3 || n === 4) return `${String(n)} ${few}`;
  return `${String(n)} ${many}`;
}

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

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// issue 120: XML fetch je BEST-EFFORT — samostatná funkcia (nie inline v
// `ingestOrders`), aby chyba tvaru výnimky/rejection nikdy neprepadla mimo
// tohto `try`. Chýbajúca premenná (`fetchOrderIds === undefined`, appka
// bežiaca bez `SHOPTET_ORDERS_XML_URL`) aj zlyhané stiahnutie dopadnú
// rovnako — prázdna mapa + zalogované varovanie, import CSV pokračuje
// úplne nezávisle.
async function fetchOrderIdsBestEffort(fetchOrderIds: OrderIdsFetcher | undefined): Promise<ReadonlyMap<string, number>> {
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

  let columns: readonly string[] = [];
  let malformedRowCount = 0;
  const candidates: OrderLineCandidate[] = [];
  const issues: OrderRowIssue[] = [];
  let pseudoItemCount = 0;
  let parseErrorMessage: string | null = null;
  // issue 172: `email`/`phone`/`packageNumber`/meno dopravcu sú OBJEDNÁVKOVÉ
  // polia (opakované na KAŽDOM riadku vrátane pseudo-položiek), preto sa
  // zbierajú z KAŽDÉHO riadku s neprázdnym `code` — nezávisle od toho, či
  // `mapOrderRow` ten istý riadok prijme alebo zahodí (pozri `parser.ts`'s
  // `extractOrderLevelExtra`/`mergeOrderLevelExtra`).
  const orderExtraByCode = new Map<string, OrderLevelExtra>();

  try {
    let isHeaderRow = true;
    for (const values of parseDelimited(decodeCp1250(download.body))) {
      if (isHeaderRow) {
        columns = values;
        isHeaderRow = false;
        continue;
      }
      if (values.length !== columns.length) {
        malformedRowCount += 1;
        continue;
      }
      const row: Record<string, string> = {};
      for (let i = 0; i < columns.length; i += 1) {
        const name = columns[i] ?? "";
        if (name === "") continue;
        row[name] = values[i] ?? "";
      }
      const externalOrderIdOfRow = (row["code"] ?? "").trim();
      if (externalOrderIdOfRow !== "") {
        const previous = orderExtraByCode.get(externalOrderIdOfRow) ?? EMPTY_ORDER_LEVEL_EXTRA;
        orderExtraByCode.set(externalOrderIdOfRow, mergeOrderLevelExtra(previous, extractOrderLevelExtra(row)));
      }
      const mapped = mapOrderRow(row);
      if (mapped.record !== null) {
        candidates.push(mapped.record);
        continue;
      }
      if (mapped.issue !== null) {
        if (mapped.issue.kind === "pseudo_item") {
          pseudoItemCount += 1;
        } else {
          issues.push(mapped.issue);
        }
      }
    }
  } catch (error) {
    parseErrorMessage = error instanceof Error ? error.message : String(error);
  }

  // Zoskupenie podľa objednávky (order-level polia sa v exporte opakujú na
  // KAŽDOM riadku tej istej objednávky, takže stačí vziať prvý výskyt) a podľa
  // dvojice (objednávka, variant) so SČÍTANÝM množstvom — Shoptet niekedy
  // vráti ten istý produkt v tej istej objednávke na dvoch riadkoch (návrhový
  // komentár #21, príklad objednávka 20220744/60953-42-43).
  //
  // `lineTotals` je Map vnorená v Map (nie zreťazený string kľúč typu
  // `${externalOrderId}:${variantCode}`) — zámerne, aby žiadna voľba
  // oddeľovača (dvojbodka, medzera, akýkoľvek znak) nemohla teoreticky
  // kolidovať s obsahom niektorého z oboch reťazcov.
  const orderInfo = new Map<
    string,
    {
      customerName: string;
      placedAt: Date;
      statusName: string;
      remark: string | null;
      shopRemark: string | null;
      // issue 237: rovnaký "prvý riadok na objednávku vyhráva" vzor ako
      // `customerName`/`statusName`/`remark`/`shopRemark` vyššie.
      totalPriceWithVat: string | null;
    }
  >();
  const lineTotals = new Map<string, Map<string, { externalOrderId: string; variantCode: string; quantity: number }>>();
  for (const candidate of candidates) {
    if (!orderInfo.has(candidate.externalOrderId)) {
      orderInfo.set(candidate.externalOrderId, {
        customerName: candidate.customerName,
        placedAt: candidate.placedAt,
        statusName: candidate.statusName,
        remark: candidate.remark,
        shopRemark: candidate.shopRemark,
        totalPriceWithVat: candidate.totalPriceWithVat,
      });
    }
    let byVariant = lineTotals.get(candidate.externalOrderId);
    if (byVariant === undefined) {
      byVariant = new Map();
      lineTotals.set(candidate.externalOrderId, byVariant);
    }
    const existing = byVariant.get(candidate.variantCode);
    if (existing === undefined) {
      byVariant.set(candidate.variantCode, {
        externalOrderId: candidate.externalOrderId,
        variantCode: candidate.variantCode,
        quantity: candidate.quantity,
      });
    } else {
      existing.quantity += candidate.quantity;
    }
  }
  const allLines = [...lineTotals.values()].flatMap((byVariant) => [...byVariant.values()]);

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

      let rejectionReason: string | null = null;
      if (parseErrorMessage !== null) {
        rejectionReason = `Export sa nedal prečítať — súbor je pravdepodobne neúplný alebo poškodený. ${CONSEQUENCE}`;
      } else {
        const missingColumns = REQUIRED_ORDER_COLUMNS.filter((column) => !columns.includes(column));
        if (missingColumns.length > 0) {
          rejectionReason = `V exporte chýbajú povinné stĺpce: ${missingColumns.join(", ")}. ${CONSEQUENCE}`;
        } else if (malformedRowCount > 0) {
          rejectionReason = `Export obsahuje ${formatCount(malformedRowCount, "poškodený riadok", "poškodené riadky", "poškodených riadkov")} (počet polí nesedí s hlavičkou). ${CONSEQUENCE}`;
        } else if (previousLineCount > 0) {
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
      }

      if (rejectionReason !== null) {
        log.warn(
          { rejectionReason, usableLineCount, previousLineCount, rawPath },
          "import objednávok odmietnutý — databáza zostáva nezmenená",
        );
        return { status: "rejected", reason: rejectionReason, rawPath };
      }

      const orderIdByExternalId = new Map<string, string>();
      for (const batch of chunk([...orderInfo.entries()], ORDERS_INGEST_BATCH_SIZE)) {
        const inserted = await tx
          .insert(orders)
          .values(
            batch.map(([externalOrderId, info]) => {
              const extra = orderExtraByCode.get(externalOrderId) ?? EMPTY_ORDER_LEVEL_EXTRA;
              return {
                externalOrderId,
                customerName: info.customerName,
                statusName: info.statusName,
                remark: info.remark,
                shopRemark: info.shopRemark,
                totalPriceWithVat: info.totalPriceWithVat,
                placedAt: info.placedAt,
                shoptetOrderId: orderIdsByCode.get(externalOrderId) ?? null,
                email: extra.email,
                phone: extra.phone,
                packageNumber: extra.packageNumber,
                shippingCarrierName: extra.shippingCarrierName,
                deliveryFullName: extra.deliveryFullName,
                deliveryCompany: extra.deliveryCompany,
                deliveryStreet: extra.deliveryStreet,
                deliveryHouseNumber: extra.deliveryHouseNumber,
                deliveryCity: extra.deliveryCity,
                deliveryZip: extra.deliveryZip,
                deliveryCountryName: extra.deliveryCountryName,
                weight: extra.weight,
                paymentMethodName: extra.paymentMethodName,
                priceToPay: extra.priceToPay,
              };
            }),
          )
          .onConflictDoUpdate({
            target: orders.externalOrderId,
            // `comment` sa ZÁMERNE nedáva do SET — je to manažérovo vlastné
            // pole (nikdy nepochádza zo Shoptetu, `schema-orders.ts`), re-import
            // ho nesmie prepísať/vynulovať. `status_name` (issue 59) je presný
            // OPAK — je to VŽDY Shoptetovo pole, re-import ho preto MUSÍ
            // osviežiť (objednávka prejde "Vybavuje sa" → "Vybavená" len tak,
            // že ju appka pri ďalšom importe znova uvidí). `remark` (issue 65,
            // zákaznícky odkaz) je rovnaká rodina ako `status_name` — VŽDY
            // Shoptetovo pole, re-import ho preto tiež osvieži. `shop_remark`
            // (issue 164, interná poznámka e-shopu) je TIEŽ tá istá rodina —
            // VŽDY Shoptetovo pole, ukladá sa SUROVO (rozdelenie na naše/cudzie
            // sa robí až na čítacej strane, `queries.ts`) — appka pri IMPORTE
            // do neho nikdy nezapisuje, takže tu niet čo stratiť/prepísať.
            // `email`/`phone`/`package_number`/`shipping_carrier_name` (issue
            // 172) sú Shoptetove polia, ale na rozdiel od `status_name`/
            // `remark`/`shop_remark` vyššie sú NAVYŠE COALESCE-ované — rovnaký
            // dôvod ako `shoptet_order_id` (review, PR 177): extrahujú sa z
            // KAŽDÉHO riadku objednávky (`extractOrderLevelExtra`), takže
            // jeden pokazený/inak tvarovaný export cyklus, kde niektorý z
            // týchto stĺpcov na VŠETKÝCH riadkoch danej objednávky vyjde
            // prázdny, by priamym prepísaním TICHO vynuloval už zistenú
            // hodnotu — a "Nevyzdvihnuté zásielky" (`posta-uncollected/
            // orders-source.ts`) by tú objednávku odvtedy prestalo sledovať
            // bez akéhokoľvek varovania. `coalesce` necháva predtým zistenú
            // hodnotu prežiť presne taký výpadok, zatiaľ čo skutočná NOVÁ
            // hodnota (bežný prípad — zásielka dostane číslo AŽ po prvom
            // importe) sa aj tak zapíše normálne.
            set: {
              customerName: sql`excluded.customer_name`,
              statusName: sql`excluded.status_name`,
              remark: sql`excluded.remark`,
              shopRemark: sql`excluded.shop_remark`,
              // issue 237: rovnaká rodina ako `status_name`/`remark`/
              // `shop_remark` vyššie — VŽDY Shoptetovo pole, priamo prepísané
              // (nie COALESCE-ované), re-import ho musí osviežiť na aktuálnu
              // sumu (napr. dodatočná zľava/storno položky v Shoptete).
              totalPriceWithVat: sql`excluded.total_price_with_vat`,
              placedAt: sql`excluded.placed_at`,
              shoptetOrderId: sql`coalesce(excluded.shoptet_order_id, "order"."shoptet_order_id")`,
              email: sql`coalesce(excluded.email, "order"."email")`,
              phone: sql`coalesce(excluded.phone, "order"."phone")`,
              packageNumber: sql`coalesce(excluded.package_number, "order"."package_number")`,
              shippingCarrierName: sql`coalesce(excluded.shipping_carrier_name, "order"."shipping_carrier_name")`,
              // issue 292: rovnaká rodina/dôvod ako `email`/`phone`/
              // `package_number`/`shipping_carrier_name` vyššie — COALESCE
              // chráni už zistenú doručovaciu adresu/hmotnosť/spôsob platby
              // pred tichým vynulovaním jedným pokazeným importovým cyklom.
              deliveryFullName: sql`coalesce(excluded.delivery_full_name, "order"."delivery_full_name")`,
              deliveryCompany: sql`coalesce(excluded.delivery_company, "order"."delivery_company")`,
              deliveryStreet: sql`coalesce(excluded.delivery_street, "order"."delivery_street")`,
              deliveryHouseNumber: sql`coalesce(excluded.delivery_house_number, "order"."delivery_house_number")`,
              deliveryCity: sql`coalesce(excluded.delivery_city, "order"."delivery_city")`,
              deliveryZip: sql`coalesce(excluded.delivery_zip, "order"."delivery_zip")`,
              deliveryCountryName: sql`coalesce(excluded.delivery_country_name, "order"."delivery_country_name")`,
              weight: sql`coalesce(excluded.weight, "order"."weight")`,
              paymentMethodName: sql`coalesce(excluded.payment_method_name, "order"."payment_method_name")`,
              priceToPay: sql`coalesce(excluded.price_to_pay, "order"."price_to_pay")`,
            },
          })
          .returning({ id: orders.id, externalOrderId: orders.externalOrderId });
        for (const row of inserted) orderIdByExternalId.set(row.externalOrderId, row.id);
      }

      // issue 132: `orderIdsByCode` (best-effort XML fetch, prípadne
      // ROZŠÍRENÉ za CSV okno cez `backfill.ts`'s `computeOrderIdsWindowStart`
      // — pozri `index.ts`/`cli/orders-ingest.ts`) môže poznať objednávku,
      // ktorá v TOMTO behu CSV vôbec NIE JE (staršia než jeho vlastné,
      // NEROZŠÍRENÉ okno — CSV okno sa zámerne nemení, aby sa nedotkla
      // `previousLineRatio` akceptančná logika vyššie). Bez tohto kroku by
      // upsert cyklus vyššie (ktorý ide LEN cez `orderInfo`, postavené z CSV)
      // taký záznam nikdy nenavštívil, takže jeho `shoptetOrderId` by sa
      // nikdy nezapísal, hoci XML mapa ho pozná. Priamy `UPDATE` namiesto
      // upsertu — objednávka MUSÍ už v DB existovať (z predošlého importu),
      // tento krok jej nikdy nezakladá nový riadok len z XML dát (tie
      // nenesú `customerName` ani ostatné povinné polia). `COALESCE` chráni
      // už zistené id rovnako ako hlavný upsert vyššie.
      for (const [externalOrderId, shoptetOrderId] of orderIdsByCode) {
        if (orderInfo.has(externalOrderId)) continue;
        await tx
          .update(orders)
          .set({ shoptetOrderId: sql`coalesce(${orders.shoptetOrderId}, ${shoptetOrderId})` })
          .where(eq(orders.externalOrderId, externalOrderId));
      }

      // Overenie proti `variant` tabuľke je AUTORITA nad tým, čo je skutočný
      // produkt (prefix-filter v `parser.ts` je len prvé, DB-nezávislé sito) —
      // položka, ktorú Shoptet vráti, ale náš katalóg ju nepozná (napr. dávno
      // vypnutý/premenovaný variant), sa PRESKOČÍ a zaloguje, nikdy nezhodí
      // celú transakciu na FK.
      const requestedVariantCodes = [...new Set(allLines.map((line) => line.variantCode))];
      const knownVariantCodes = new Set<string>();
      for (const batch of chunk(requestedVariantCodes, ORDERS_INGEST_BATCH_SIZE)) {
        if (batch.length === 0) continue;
        const rows = await tx.select({ code: variants.code }).from(variants).where(inArray(variants.code, batch));
        for (const row of rows) knownVariantCodes.add(row.code);
      }

      let skippedItemCount = 0;
      const usableLines: { externalOrderId: string; variantCode: string; quantity: number }[] = [];
      for (const line of allLines) {
        if (!knownVariantCodes.has(line.variantCode)) {
          skippedItemCount += 1;
          log.warn(
            { externalOrderId: line.externalOrderId, variantCode: line.variantCode },
            "položka objednávky odkazuje na neznámy variant — riadok sa preskočil",
          );
          continue;
        }
        usableLines.push(line);
      }

      let insertedLineCount = 0;
      for (const batch of chunk(usableLines, ORDERS_INGEST_BATCH_SIZE)) {
        await tx
          .insert(orderLines)
          .values(
            batch.map((line) => {
              const orderId = orderIdByExternalId.get(line.externalOrderId);
              if (orderId === undefined) {
                throw new Error(`Interná chyba: chýba id objednávky ${line.externalOrderId}`);
              }
              return { orderId, variantCode: line.variantCode, quantity: line.quantity };
            }),
          )
          .onConflictDoUpdate({
            target: [orderLines.orderId, orderLines.variantCode],
            // `state` sa ZÁMERNE nedáva do SET — je to appkou/manažérom
            // riadený stavový automat (schema-orders.ts), nikdy zo Shoptetu;
            // re-import smie osviežiť len množstvo, nikdy nevrátiť rozpracovaný
            // riadok naspäť na "objednane".
            set: { quantity: sql`excluded.quantity` },
          });
        insertedLineCount += batch.length;
      }

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
      let deletedStaleLineCount = 0;
      for (const [externalOrderId, orderId] of orderIdByExternalId) {
        const byVariant = lineTotals.get(externalOrderId);
        // Nemôže nastať v praxi (`orderIdByExternalId` aj `lineTotals` sa
        // plnia z toho istého `candidates` prechodu vyššie) — defenzívne,
        // aby prípadný budúci refaktor tento predpoklad nikdy ticho
        // neporušil zmazaním všetkých riadkov danej objednávky.
        if (byVariant === undefined) continue;
        const keepVariantCodes = [...byVariant.keys()];
        const deleted = await tx
          .delete(orderLines)
          .where(and(eq(orderLines.orderId, orderId), notInArray(orderLines.variantCode, keepVariantCodes)))
          .returning({ id: orderLines.id });
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
