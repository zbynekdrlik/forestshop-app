import { inArray, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderLines, orders, variants } from "../../db/schema.js";
import { log } from "../../logger.js";
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

// issue 595: zdieľané jadro importu objednávok — PARSOVANIE exportu + ZÁPIS
// objednávok a ich riadkov. Vyčlenené z `ingest.ts`'s `ingestOrders`, aby ho
// jednorazový doimport starších OTVORENÝCH objednávok (`backfill-open.ts`, CLI
// `orders-backfill-open`) volal BEZ kópie logiky — ten istý parser, to isté
// zoskupenie (prvý riadok na objednávku vyhráva, sčítanie duplicitných
// produktov), ten istý upsert (COALESCE polia, `comment`/`state` mimo `set`).
// To, čo je ŠPECIFICKÉ pre bežný 15-min import (akceptačná brána okna, mazanie
// zastaraných riadkov #412, XML-only doplnenie id, Upozornenia), ostáva v
// `ingest.ts` — doimport to zámerne nespúšťa.

// Rovnaký dôvod ako katalóg's `INGEST_BATCH_SIZE`: veľký INSERT narazí na
// limit 65 535 parametrov na príkaz v protokole Postgresu. 90-dňové okno má
// rádovo stovky objednávok/riadkov, takže toto v praxi znamená jednu dávku —
// hodnota je tu pre bezpečnosť, keby sa okno niekedy rozšírilo.
export const ORDERS_INGEST_BATCH_SIZE = 500;

export const ORDERS_UNCHANGED_CONSEQUENCE = "Objednávky zostávajú nezmenené, import môžete kedykoľvek zopakovať.";

/**
 * Slovenská číselná zhoda pre "riadok"/"položka" — rovnaký vzor ako
 * `catalog/validation.ts`'s `formatMalformedRows`: 1 → jednotné číslo, LITERÁLNE
 * 2/3/4 → málopočetné (paucal), všetko ostatné (0, 5+, aj 22/23/24…) → rodový
 * pád množného čísla — slovenčina (na rozdiel od ruštiny/poľštiny) neodvodzuje
 * tvar z poslednej číslice, takže 22 berie rovnaký tvar ako 21 alebo 25.
 */
export function formatCount(n: number, one: string, few: string, many: string): string {
  if (n === 1) return `1 ${one}`;
  if (n === 2 || n === 3 || n === 4) return `${String(n)} ${few}`;
  return `${String(n)} ${many}`;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface OrderInfo {
  readonly customerName: string;
  readonly placedAt: Date;
  readonly statusName: string;
  readonly remark: string | null;
  readonly shopRemark: string | null;
  // issue 237: rovnaký "prvý riadok na objednávku vyhráva" vzor ako
  // `customerName`/`statusName`/`remark`/`shopRemark` vyššie.
  readonly totalPriceWithVat: string | null;
}

export interface OrderLineTotal {
  readonly externalOrderId: string;
  readonly variantCode: string;
  quantity: number;
}

export interface ParsedOrdersExport {
  readonly columns: readonly string[];
  readonly malformedRowCount: number;
  readonly issues: readonly OrderRowIssue[];
  readonly pseudoItemCount: number;
  readonly parseErrorMessage: string | null;
  readonly orderExtraByCode: ReadonlyMap<string, OrderLevelExtra>;
  readonly orderInfo: ReadonlyMap<string, OrderInfo>;
  // Map vnorená v Map (nie zreťazený string kľúč) — dôvod v komentári pri plnení nižšie.
  readonly lineTotals: ReadonlyMap<string, ReadonlyMap<string, OrderLineTotal>>;
  readonly allLines: readonly OrderLineTotal[];
}

/** Čisté (bez DB) parsovanie + zoskupenie surového CSV exportu objednávok. */
export function parseOrdersExport(body: Buffer): ParsedOrdersExport {
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
    for (const values of parseDelimited(decodeCp1250(body))) {
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
  const orderInfo = new Map<string, OrderInfo>();
  const lineTotals = new Map<string, Map<string, OrderLineTotal>>();
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
  return { columns, malformedRowCount, issues, pseudoItemCount, parseErrorMessage, orderExtraByCode, orderInfo, lineTotals, allLines };
}

/**
 * Štrukturálne odmietnutie exportu (nedal sa prečítať / chýbajú povinné stĺpce /
 * počet polí nesedí s hlavičkou) — NEZÁVISLÉ od stavu DB, preto zdieľané bežným
 * importom aj doimportom. `null` = export je štrukturálne v poriadku.
 */
export function structuralRejectionReason(parsed: ParsedOrdersExport): string | null {
  if (parsed.parseErrorMessage !== null) {
    return `Export sa nedal prečítať — súbor je pravdepodobne neúplný alebo poškodený. ${ORDERS_UNCHANGED_CONSEQUENCE}`;
  }
  const missingColumns = REQUIRED_ORDER_COLUMNS.filter((column) => !parsed.columns.includes(column));
  if (missingColumns.length > 0) {
    return `V exporte chýbajú povinné stĺpce: ${missingColumns.join(", ")}. ${ORDERS_UNCHANGED_CONSEQUENCE}`;
  }
  if (parsed.malformedRowCount > 0) {
    return `Export obsahuje ${formatCount(parsed.malformedRowCount, "poškodený riadok", "poškodené riadky", "poškodených riadkov")} (počet polí nesedí s hlavičkou). ${ORDERS_UNCHANGED_CONSEQUENCE}`;
  }
  return null;
}

export interface UpsertOrdersInput {
  readonly orderInfo: ReadonlyMap<string, OrderInfo>;
  readonly orderExtraByCode: ReadonlyMap<string, OrderLevelExtra>;
  readonly orderIdsByCode: ReadonlyMap<string, number>;
  readonly lines: readonly OrderLineTotal[];
}

export interface UpsertOrdersResult {
  readonly orderIdByExternalId: ReadonlyMap<string, string>;
  readonly insertedLineCount: number;
  readonly skippedItemCount: number;
}

/**
 * Zapíše objednávky (`orderInfo`) a ich riadky (`lines`). VOLAJÚCI drží
 * transakciu aj advisory zámok `INGEST_ORDERS_ADVISORY_LOCK_KEY` (`ingest.ts`).
 * Riadok s variantom, ktorý katalóg nepozná, sa preskočí a zaloguje
 * (`skippedItemCount`) — nikdy nezhodí transakciu na FK.
 */
export async function upsertOrdersAndLines(
  tx: Pick<Database, "insert" | "select">,
  input: UpsertOrdersInput,
): Promise<UpsertOrdersResult> {
  const { orderInfo, orderExtraByCode, orderIdsByCode } = input;
  const allLines = input.lines;
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
  const usableLines: OrderLineTotal[] = [];
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

  return { orderIdByExternalId, insertedLineCount, skippedItemCount };
}
