import { createHash } from "node:crypto";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { catalogSnapshots, ingestIssues, products, variants } from "../../db/schema.js";
import { log } from "../../logger.js";
import { decodeCp1250, parseDelimited } from "./csv.js";
import { mapRow, type RowIssue, type VariantRecord } from "./map-row.js";
import { storeRawSnapshot } from "./raw-store.js";
import {
  CONSEQUENCE,
  DEFAULT_SNAPSHOT_LIMITS,
  judgeSnapshot,
  type SnapshotJudgement,
  type SnapshotLimits,
} from "./validation.js";

/**
 * 14 014 variantov × 21 stĺpcov = ~294 000 parametrov na jeden INSERT, čo je ďaleko
 * nad limitom 65 535 parametrov na príkaz v protokole Postgresu. 500 riadkov na dávku
 * dá ~10 500 parametrov — bezpečne pod limitom a stále len ~29 príkazov na import.
 * Všetky dávky bežia v JEDNEJ transakcii, takže import prejde celý alebo vôbec.
 */
export const INGEST_BATCH_SIZE = 500;

export interface ExportDownload {
  readonly body: Buffer;
  readonly sourceLabel: string;
}

export type ExportFetcher = () => Promise<ExportDownload>;

export interface CatalogIngestOptions {
  readonly fetchExport: ExportFetcher;
  readonly now: Date;
  readonly rawDir: string;
  readonly limits?: SnapshotLimits;
}

export type CatalogIngestResult =
  | {
      readonly status: "accepted";
      readonly snapshotId: string;
      readonly variantCount: number;
      readonly productCount: number;
      readonly missingCount: number;
      readonly issueCount: number;
    }
  | { readonly status: "rejected"; readonly snapshotId: string; readonly reason: string }
  | { readonly status: "duplicate"; readonly snapshotId: string };

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function ingestCatalog(
  db: Database,
  options: CatalogIngestOptions,
): Promise<CatalogIngestResult> {
  const download = await options.fetchExport();
  const byteSize = download.body.byteLength;
  const contentSha256 = createHash("sha256").update(download.body).digest("hex");

  const [duplicate] = await db
    .select({ id: catalogSnapshots.id })
    .from(catalogSnapshots)
    .where(
      and(
        eq(catalogSnapshots.contentSha256, contentSha256),
        eq(catalogSnapshots.verdict, "accepted"),
      ),
    )
    .limit(1);
  if (duplicate !== undefined) {
    log.info({ snapshotId: duplicate.id, contentSha256 }, "rovnaký export už bol prijatý");
    return { status: "duplicate", snapshotId: duplicate.id };
  }

  // Surové bajty sa ukladajú PRED parsovaním, nie po ňom — aj neúspešné
  // parsovanie (napr. `parseDelimited`/csv.ts vyhodí, lebo súbor sa skončil
  // vnútri zacitovanej bunky — pretrhnuté sťahovanie) musí nechať dôkaz na
  // vyšetrenie. Odmietnutý export je dôkaz, nie odpad — to isté pravidlo, čo
  // platí pre každé iné odmietnutie.
  const rawPath = await storeRawSnapshot(options.rawDir, {
    at: options.now,
    sha256: contentSha256,
    body: download.body,
  });

  // JEDEN prechod nad `parseDelimited(decodeCp1250(...))`: prvé vyparsované pole
  // je hlavička, každé ďalšie je dátový riadok. Predtým sa volalo `parseShoptetCsv`
  // (hotové záznamy cez `.rows()`) A ZVLÁŠŤ `parseDelimited` (počítanie
  // poškodených riadkov) nad tou istou 54 MB dekódovanou stránkou — dve
  // rozparsovania tam, kde stačí jedno (task-3-fix-2; `parseShoptetCsv` zostáva
  // nedotknutý pre ostatných volajúcich, len tu už nie je potrebný).
  //
  // `parseDelimited` VYHODÍ, keď súbor skončí vnútri zacitovanej bunky (csv.ts)
  // — to je pretrhnuté sťahovanie, nie programátorská chyba, takže sa CHYTÁ a
  // mení na bežný `rejected` verdikt namiesto výnimky unikajúcej z `ingestCatalog`.
  let columns: readonly string[] = [];
  let rowCount = 0;
  let malformedRowCount = 0;
  const issues: RowIssue[] = [];
  const records: VariantRecord[] = [];
  let parseErrorMessage: string | null = null;

  try {
    const seen = new Set<string>();
    let isHeaderRow = true;
    for (const values of parseDelimited(decodeCp1250(download.body))) {
      if (isHeaderRow) {
        columns = values;
        isHeaderRow = false;
        continue;
      }
      rowCount += 1;
      // Poškodený riadok (napr. jedna nezacitovaná úvodzovka v popise) rozdelí
      // jeden riadok CSV na dva, obidva plné prázdnych polí — počet polí
      // nesediaci s dĺžkou hlavičky je jediný spoľahlivý signál.
      if (values.length !== columns.length) {
        malformedRowCount += 1;
        continue;
      }
      const row: Record<string, string> = {};
      for (let i = 0; i < columns.length; i += 1) {
        const name = columns[i] ?? "";
        // Export končí bodkočiarkou, takže posledný stĺpec má prázdne meno.
        if (name === "") continue;
        row[name] = values[i] ?? "";
      }
      const mapped = mapRow(row);
      issues.push(...mapped.issues);
      if (mapped.record === null) continue;
      if (seen.has(mapped.record.code)) {
        issues.push({
          kind: "duplicate_code",
          code: mapped.record.code,
          detail: { name: mapped.record.name },
        });
        continue;
      }
      seen.add(mapped.record.code);
      records.push(mapped.record);
    }
  } catch (error) {
    parseErrorMessage = error instanceof Error ? error.message : String(error);
  }

  // Beží bez ohľadu na úspech parsovania — pri zlyhaní je `records` prázdne pole,
  // takže je to no-op (nič sa neprepočítava druhýkrát).
  const productValues = new Map<string, { name: string; supplier: string | null }>();
  for (const record of records) {
    const known = productValues.get(record.productKey);
    if (known === undefined) {
      productValues.set(record.productKey, { name: record.name, supplier: record.supplier });
      continue;
    }
    if (known.name !== record.name) {
      issues.push({
        kind: "product_name_conflict",
        code: record.code,
        detail: { productKey: record.productKey, expected: known.name, found: record.name },
      });
    }
  }

  const [previous] = await db
    .select({ rowCount: catalogSnapshots.rowCount })
    .from(catalogSnapshots)
    .where(eq(catalogSnapshots.verdict, "accepted"))
    .orderBy(desc(catalogSnapshots.fetchedAt))
    .limit(1);

  // Zlyhané parsovanie je VŽDY "rejected" a nikdy nejde cez `judgeSnapshot` — nemá
  // zmysel posudzovať stĺpce/počet riadkov, ktoré sa nepodarilo zistiť. Veta o
  // dôsledku je tá istá `CONSEQUENCE`, ktorú importujeme z `validation.ts` —
  // nie druhý literál, ktorý by sa mohol nenápadne rozísť pri budúcej zmene
  // znenia. #286 platí rovnako pre zlyhané parsovanie ako pre každé iné
  // odmietnutie.
  const judgement: SnapshotJudgement =
    parseErrorMessage !== null
      ? {
          verdict: "rejected",
          reason: `Export sa nedal prečítať: ${parseErrorMessage} ${CONSEQUENCE}`,
        }
      : judgeSnapshot(
          { columns, rowCount, byteSize, malformedRowCount, previousAccepted: previous ?? null },
          options.limits ?? DEFAULT_SNAPSHOT_LIMITS,
        );

  return await db.transaction(async (tx): Promise<CatalogIngestResult> => {
    const [snapshot] = await tx
      .insert(catalogSnapshots)
      .values({
        fetchedAt: options.now,
        sourceLabel: download.sourceLabel,
        contentSha256,
        byteSize,
        rowCount,
        // Pri zlyhanom parsovaní je `columns` prázdne pole — nevieme, aké stĺpce
        // export mal, ale záznam sa aj tak zapisuje (s `rawPath`), aby sa dal
        // pokazený export spätne preskúmať.
        columns: [...columns],
        verdict: judgement.verdict,
        rejectionReason: judgement.verdict === "rejected" ? judgement.reason : null,
        rawPath,
        variantCount: judgement.verdict === "accepted" ? records.length : null,
        productCount: judgement.verdict === "accepted" ? productValues.size : null,
        issueCount: judgement.verdict === "accepted" ? issues.length : null,
      })
      .returning({ id: catalogSnapshots.id });
    if (snapshot === undefined) throw new Error("Snapshot sa nepodarilo zapísať");
    const snapshotId = snapshot.id;

    if (judgement.verdict === "rejected") {
      log.warn(
        { snapshotId, reason: judgement.reason, rowCount, byteSize, columns: columns.length },
        "export odmietnutý — katalóg zostáva na poslednom prijatom snapshote",
      );
      return { status: "rejected", snapshotId, reason: judgement.reason };
    }

    for (const batch of chunk([...productValues.entries()], INGEST_BATCH_SIZE)) {
      await tx
        .insert(products)
        .values(
          batch.map(([key, value]) => ({
            key,
            name: value.name,
            supplier: value.supplier,
            firstSeenAt: options.now,
            lastSeenAt: options.now,
            lastSeenSnapshotId: snapshotId,
          })),
        )
        .onConflictDoUpdate({
          target: products.key,
          set: {
            name: sql`excluded.name`,
            supplier: sql`excluded.supplier`,
            lastSeenAt: options.now,
            lastSeenSnapshotId: snapshotId,
          },
        });
    }

    for (const batch of chunk(records, INGEST_BATCH_SIZE)) {
      await tx
        .insert(variants)
        .values(
          batch.map((record) => ({
            ...record,
            firstSeenAt: options.now,
            lastSeenAt: options.now,
            lastSeenSnapshotId: snapshotId,
            missingSince: null,
          })),
        )
        .onConflictDoUpdate({
          target: variants.code,
          set: {
            productKey: sql`excluded.product_key`,
            sizeLabel: sql`excluded.size_label`,
            pairCode: sql`excluded.pair_code`,
            name: sql`excluded.name`,
            currency: sql`excluded.currency`,
            price: sql`excluded.price`,
            standardPrice: sql`excluded.standard_price`,
            purchasePrice: sql`excluded.purchase_price`,
            actionPrice: sql`excluded.action_price`,
            actionFrom: sql`excluded.action_from`,
            actionUntil: sql`excluded.action_until`,
            percentVat: sql`excluded.percent_vat`,
            includingVat: sql`excluded.including_vat`,
            stock: sql`excluded.stock`,
            availabilityInStockText: sql`excluded.availability_in_stock_text`,
            availabilityOutOfStockText: sql`excluded.availability_out_of_stock_text`,
            availabilityText: sql`excluded.availability_text`,
            productVisibility: sql`excluded.product_visibility`,
            state: sql`excluded.state`,
            lastSeenAt: options.now,
            lastSeenSnapshotId: snapshotId,
            // Variant, ktorý sa vrátil, prestáva chýbať.
            missingSince: null,
          },
        });
    }

    const missing = await tx
      .update(variants)
      .set({ missingSince: options.now })
      .where(and(ne(variants.lastSeenSnapshotId, snapshotId), isNull(variants.missingSince)))
      .returning({ code: variants.code });

    for (const batch of chunk(issues, INGEST_BATCH_SIZE)) {
      await tx
        .insert(ingestIssues)
        .values(batch.map((issue) => ({ ...issue, snapshotId, at: options.now })));
    }

    log.info(
      {
        snapshotId,
        variantCount: records.length,
        productCount: productValues.size,
        missingCount: missing.length,
        issueCount: issues.length,
        rowCount,
        byteSize,
      },
      "katalóg naimportovaný",
    );

    return {
      status: "accepted",
      snapshotId,
      variantCount: records.length,
      productCount: productValues.size,
      missingCount: missing.length,
      issueCount: issues.length,
    };
  });
}
