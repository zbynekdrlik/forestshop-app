import { createHash } from "node:crypto";
import { between, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orderLines, orders, variants } from "../../db/schema.js";
import { log } from "../../logger.js";
import { storeRawSnapshot } from "../catalog/raw-store.js";
import { redactSourceLabel } from "./fetcher.js";
import {
  decodeCp1250,
  mapOrderRow,
  parseDelimited,
  REQUIRED_ORDER_COLUMNS,
  type OrderLineCandidate,
  type OrderRowIssue,
} from "./parser.js";

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
}

export type OrdersIngestResult =
  | {
      readonly status: "accepted";
      readonly orderCount: number;
      readonly lineCount: number;
      readonly skippedItemCount: number;
      readonly pseudoItemCount: number;
      readonly issueCount: number;
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

export async function ingestOrders(db: Database, options: OrdersIngestOptions): Promise<OrdersIngestResult> {
  const download = await options.fetchExport();
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
  const orderInfo = new Map<string, { customerName: string; placedAt: Date }>();
  const lineTotals = new Map<string, Map<string, { externalOrderId: string; variantCode: string; quantity: number }>>();
  for (const candidate of candidates) {
    if (!orderInfo.has(candidate.externalOrderId)) {
      orderInfo.set(candidate.externalOrderId, {
        customerName: candidate.customerName,
        placedAt: candidate.placedAt,
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
            batch.map(([externalOrderId, info]) => ({
              externalOrderId,
              customerName: info.customerName,
              placedAt: info.placedAt,
            })),
          )
          .onConflictDoUpdate({
            target: orders.externalOrderId,
            // `comment` sa ZÁMERNE nedáva do SET — je to manažérovo vlastné
            // pole (nikdy nepochádza zo Shoptetu, `schema-orders.ts`), re-import
            // ho nesmie prepísať/vynulovať.
            set: {
              customerName: sql`excluded.customer_name`,
              placedAt: sql`excluded.placed_at`,
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

      log.info(
        {
          orderCount: orderInfo.size,
          lineCount: insertedLineCount,
          skippedItemCount,
          pseudoItemCount,
          issueCount: issues.length,
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
