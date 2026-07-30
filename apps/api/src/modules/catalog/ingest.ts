import { createHash } from "node:crypto";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { catalogSnapshots, ingestIssues, products, variants } from "../../db/schema.js";
import { log } from "../../logger.js";
import { decodeCp1250, parseDelimited } from "./csv.js";
import { redactSourceLabel } from "./fetcher.js";
import { mapRow, type RowIssue, type VariantRecord } from "./map-row.js";
import { storeRawSnapshot } from "./raw-store.js";
import {
  CONSEQUENCE,
  DEFAULT_SNAPSHOT_LIMITS,
  judgeSnapshot,
  type SnapshotJudgement,
  type SnapshotLimits,
} from "./validation.js";

// Zámok je JEDEN pevný kľúč, NIE odvodený z obsahu (review task-5-fix-1,
// dôležité #4) — serializuje VŠETKY súbežné importy voči tejto databáze,
// nielen tie s rovnakým obsahom. Bez toho by dva importy RÔZNYCH bajtov mohli
// bežať súbežne a ten, čo commitne neskôr, by blanketovým UPDATE-om
// (nižšie, "missing") označil čerstvo zapísané varianty toho druhého ako
// chýbajúce. `pg_advisory_xact_lock` sa uvoľní automaticky na konci
// transakcie (COMMIT aj ROLLBACK), takže nepotrebuje explicitné odomknutie.
// Exportované len pre test (`catalog-ingest.integration.test.ts`, review
// final-wave-a položka 3) — test drží tento istý zámok manuálne
// (`pg_advisory_lock`, session-scoped) z druhého pripojenia, aby deterministicky
// (bez spoliehania sa na časovanie) dokázal, že brána prijatia teraz číta
// predchádzajúci prijatý snapshot AŽ PO získaní zámku, nie pred otvorením
// transakcie.
export const INGEST_ADVISORY_LOCK_KEY = 787_878_001;

// SQLSTATE 23505 = unique_violation. Používa sa na odchytenie súbehu dvoch
// importov ROVNAKÉHO obsahu: aj so zámokom vyššie je toto druhá poistka —
// ak by prvý import commitol tesne pred týmto INSERT-om, tento INSERT do
// `catalog_snapshot` narazí na `catalog_snapshot_accepted_sha_uq` namiesto
// toho, aby ho úvodná kontrola duplicity (ktorá beží MIMO transakcie, teda
// pred zámokom) stihla zachytiť.
function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === constraint
  );
}

/**
 * 14 014 variantov × 25 stĺpcov (tabuľka `variant`, task-5-fix-1 pridal `guid`)
 * = ~350 350 parametrov na jeden INSERT, čo je ďaleko nad limitom 65 535
 * parametrov na príkaz v protokole Postgresu. 500 riadkov na dávku dá ~12 500
 * parametrov — bezpečne pod limitom a stále len ~29 príkazov na import.
 * Všetky dávky bežia v JEDNEJ transakcii, takže import prejde celý alebo vôbec.
 */
export const INGEST_BATCH_SIZE = 500;

// Štítky pre `validation.ts`'s "najčastejšia príčina" v dôvode odmietnutia —
// LEN pre druhy anomálií, ktoré SPÔSOBIA, že riadok nevyrobí použiteľný
// záznam (`records.length` ho nezapočíta). `missing_currency`/`invalid_money`/
// `invalid_stock`/`product_name_conflict` naopak stále vyrobia zapísaný
// záznam (len s vynulovaným/zahodeným poľom) — korelačne teda NEPATRIA sem,
// ich pomenovanie ako "prevažujúcej príčiny nepoužiteľnosti" by prevádzkovateľa
// zavádzalo.
const UNUSABLE_ISSUE_LABELS: Readonly<Partial<Record<RowIssue["kind"], string>>> = Object.freeze({
  empty_code: "prázdny kód",
  empty_guid: "prázdny guid (identita produktu)",
  duplicate_code: "duplicitný kód",
});

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
      // Počet variantov NOVO označených ako chýbajúce PRI TOMTO importe (tie,
      // ktoré predtým `missingSince: null` mali a teraz ho stratili) — NIE
      // celkový počet chýbajúcich variantov v katalógu. API vrstva, ktorá toto
      // pole zobrazuje, si na "celkový počet chýbajúcich" musí spočítať
      // vlastný dopyt (`missingSince IS NOT NULL`), toto pole na to neslúži.
      readonly missingCount: number;
      readonly issueCount: number;
    }
  | { readonly status: "rejected"; readonly snapshotId: string; readonly reason: string }
  | { readonly status: "duplicate"; readonly snapshotId: string };

// Žije tu (modules/catalog), nie v http/catalog-routes.ts, kde bol pôvodne
// definovaný — F2 scheduler (`modules/scheduler/jobs.ts`) ho tiež potrebuje a
// `modules/` importujúce z `http/` by obrátilo bežný smer závislostí v repe
// (http závisí od modules, nikdy naopak). `catalog-routes.ts` ho odtiaľto
// re-exportuje, aby `http/app.ts` nemusel meniť svoj import.
export type RunIngest = (now: Date) => Promise<CatalogIngestResult>;

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
    // Duplicitný import nezapíše žiadny nový riadok, ale MUSÍ zaznamenať, že
    // kontrola prebehla — inak zostáva jediný ukazovateľ čerstvosti
    // (`fetched_at`) navždy zamrznutý na prvom stiahnutí, zatiaľ čo naplánovaný
    // import každú noc hlási úspech (review final-wave-a, položka 5; presne ten
    // tvar historického výpadku, ktorému má táto fáza zabrániť). `fetchedAt`,
    // `rowCount` a všetko ostatné na riadku ostáva nedotknuté — mení sa LEN
    // `lastConfirmedAt`.
    await db
      .update(catalogSnapshots)
      .set({ lastConfirmedAt: options.now })
      .where(eq(catalogSnapshots.id, duplicate.id));
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

  // Rozpiska príčin nepoužiteľnosti pre `judgeSnapshot`'s "najčastejšia príčina"
  // (validation.ts) — počíta LEN druhy z `UNUSABLE_ISSUE_LABELS` vyššie, nikdy
  // celý `issues`. Pri zlyhanom parsovaní je `issues` prázdne, takže je to no-op.
  const unusableReasonCounts: Record<string, number> = {};
  for (const issue of issues) {
    const label = UNUSABLE_ISSUE_LABELS[issue.kind];
    if (label === undefined) continue;
    unusableReasonCounts[label] = (unusableReasonCounts[label] ?? 0) + 1;
  }

  // Beží bez ohľadu na úspech parsovania — pri zlyhaní je `records` prázdne pole,
  // takže je to no-op (nič sa neprepočítava druhýkrát).
  const productValues = new Map<string, { name: string; supplier: string | null; internalNote: string | null }>();
  for (const record of records) {
    const known = productValues.get(record.productKey);
    if (known === undefined) {
      productValues.set(record.productKey, {
        name: record.name,
        supplier: record.supplier,
        internalNote: record.internalNote,
      });
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

  let result: CatalogIngestResult;
  try {
    result = await db.transaction(async (tx): Promise<CatalogIngestResult> => {
      // Zámok MUSÍ byť prvý príkaz v transakcii (review task-5-fix-1, dôležité
      // #4) — pozri komentár pri `INGEST_ADVISORY_LOCK_KEY` vyššie.
      await tx.execute(sql`select pg_advisory_xact_lock(${INGEST_ADVISORY_LOCK_KEY})`);

      // Predchádzajúci prijatý snapshot (základ brány) sa číta AŽ TU — HNEĎ PO
      // získaní zámku, nie pred otvorením transakcie (review final-wave-a,
      // položka 3, Important #6). Dva súbežné importy (napr. tlačidlo na webe
      // a príkazový riadok naraz) by inak mohli oba čítať ROVNAKÝ (starý)
      // základ, hoci jeden z nich medzitým commitne nový, väčší — malý export,
      // ktorý by postupne (jeden po druhom) bol odmietnutý, by tak mohol
      // prejsť, a po commite by blanketový update označil tisíce variantov
      // toho druhého ako chýbajúce. Zámok serializuje VŠETKY súbežné importy
      // (pozri komentár pri `INGEST_ADVISORY_LOCK_KEY` vyššie), takže výber tu
      // — na tej istej transakcii, hneď po získaní zámku — vidí VŽDY posledný
      // skutočne commitnutý stav, nikdy stav spred neho.
      //
      // `orderBy` má DVA kľúče (minor, review task-5-fix-1): samotné
      // `fetchedAt` by pri dvoch snapshotoch so ZHODNÝM časom (napr. vstreknuté
      // `now` v teste, alebo dva importy v tej istej milisekunde) vrátilo
      // poradie, ktoré Postgres negarantuje — `id` ako druhý, stabilný kľúč
      // robí výber deterministickým (vždy ten istý riadok pri opakovanom
      // behu), aj keď samotná hodnota `id` (náhodné UUID) nenesie žiadny
      // časový význam.
      const [previous] = await tx
        .select({ rowCount: catalogSnapshots.rowCount })
        .from(catalogSnapshots)
        .where(eq(catalogSnapshots.verdict, "accepted"))
        .orderBy(desc(catalogSnapshots.fetchedAt), desc(catalogSnapshots.id))
        .limit(1);

      // Zlyhané parsovanie je VŽDY "rejected" a nikdy nejde cez `judgeSnapshot` — nemá
      // zmysel posudzovať stĺpce/počet riadkov, ktoré sa nepodarilo zistiť. Veta o
      // dôsledku je tá istá `CONSEQUENCE`, ktorú importujeme z `validation.ts` —
      // nie druhý literál, ktorý by sa mohol nenápadne rozísť pri budúcej zmene
      // znenia. #286 platí rovnako pre zlyhané parsovanie ako pre každé iné
      // odmietnutie.
      //
      // Dôvod pre PREVÁDZKOVATEĽA je PEVNÁ slovenská veta (minor, review
      // task-5-fix-1) — surová `parseErrorMessage` sa do nej NIKDY neinterpoluje
      // (môže byť anglická/technická, z internej knižnice). Surová správa sa
      // loguje samostatne nižšie (`log.warn`, pole `parseError`), nikdy sa
      // nezobrazuje prevádzkovateľovi.
      const judgement: SnapshotJudgement =
        parseErrorMessage !== null
          ? {
              verdict: "rejected",
              reason: `Export sa nedal prečítať — súbor je pravdepodobne neúplný alebo poškodený. ${CONSEQUENCE}`,
            }
          : judgeSnapshot(
              {
                columns,
                rowCount,
                byteSize,
                malformedRowCount,
                // Použiteľné = rozparsované ZÁZNAMY, ktoré vyrobili DB riadok
                // (task-5-fix-1, dôležité #3) — `records.length` už vylučuje
                // riadky s prázdnym `code`/`guid` aj duplicity, presne to, čo sa
                // nakoniec zapíše do `variant`.
                usableRecordCount: records.length,
                unusableReasonCounts,
                previousAccepted: previous ?? null,
              },
              options.limits ?? DEFAULT_SNAPSHOT_LIMITS,
            );

      const [snapshot] = await tx
        .insert(catalogSnapshots)
        .values({
          fetchedAt: options.now,
          // Pri prvom zápise je "naposledy potvrdené" to isté ako "naposledy
          // stiahnuté" — rozíde sa až prvým budúcim DUPLICITNÝM importom.
          lastConfirmedAt: options.now,
          // Služba dôveruje `sourceLabel` od AKÉHOKOĽVEK vstreknutého fetchera
          // (minor, review task-5-fix-1) — prekrytie tu je druhá poistka, nie
          // len v `createHttpExportFetcher`; na už prekrytej URL je no-op.
          sourceLabel: redactSourceLabel(download.sourceLabel),
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
          {
            snapshotId,
            reason: judgement.reason,
            rowCount,
            byteSize,
            columns: columns.length,
            // Surová správa z parsera (môže byť anglická/technická) sa loguje
            // TU, samostatne — `judgement.reason` (uložený do DB, zobrazený
            // prevádzkovateľovi) ju už neobsahuje (minor, review task-5-fix-1).
            ...(parseErrorMessage !== null ? { parseError: parseErrorMessage } : {}),
          },
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
              internalNote: value.internalNote,
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
              internalNote: sql`excluded.internal_note`,
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
              // Polia sa vypisujú EXPLICITNE, nie `...record` (minor, review
              // task-5-fix-1) — `record.supplier`/`record.internalNote`
              // patria stĺpcu `product`, nie `variant`; predtým to fungovalo
              // len preto, že ORM neznáme kľúče ticho zahodí.
              code: record.code,
              productKey: record.productKey,
              guid: record.guid,
              sizeLabel: record.sizeLabel,
              pairCode: record.pairCode,
              externalCode: record.externalCode,
              name: record.name,
              currency: record.currency,
              price: record.price,
              standardPrice: record.standardPrice,
              purchasePrice: record.purchasePrice,
              actionPrice: record.actionPrice,
              actionFrom: record.actionFrom,
              actionUntil: record.actionUntil,
              percentVat: record.percentVat,
              includingVat: record.includingVat,
              stock: record.stock,
              availabilityInStockText: record.availabilityInStockText,
              availabilityOutOfStockText: record.availabilityOutOfStockText,
              availabilityText: record.availabilityText,
              productVisibility: record.productVisibility,
              state: record.state,
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
              guid: sql`excluded.guid`,
              sizeLabel: sql`excluded.size_label`,
              pairCode: sql`excluded.pair_code`,
              externalCode: sql`excluded.external_code`,
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
  } catch (error) {
    // Súbeh dvoch importov ROVNAKÉHO obsahu (dôležité #4): zámok vyššie ich
    // serializuje, no toto je druhá poistka — ak by druhý predsa len vošiel
    // do INSERT-u tesne po commite prvého, narazí na
    // `catalog_snapshot_accepted_sha_uq` a preloží sa na normálny `duplicate`
    // výsledok, nie na uniknutú výnimku.
    if (isUniqueViolation(error, "catalog_snapshot_accepted_sha_uq")) {
      const [existing] = await db
        .select({ id: catalogSnapshots.id })
        .from(catalogSnapshots)
        .where(
          and(
            eq(catalogSnapshots.contentSha256, contentSha256),
            eq(catalogSnapshots.verdict, "accepted"),
          ),
        )
        .limit(1);
      if (existing !== undefined) {
        // Rovnaká confirmation-only aktualizácia ako na hlavnej duplicitnej
        // ceste vyššie — aj TENTO import overil, že katalóg je aktuálny.
        await db
          .update(catalogSnapshots)
          .set({ lastConfirmedAt: options.now })
          .where(eq(catalogSnapshots.id, existing.id));
        log.info(
          { snapshotId: existing.id, contentSha256 },
          "súbežný import rovnakého obsahu — preložené na duplicate",
        );
        return { status: "duplicate", snapshotId: existing.id };
      }
    }

    // Materializácia (INSERT/UPDATE produktov, variantov, missing-marking)
    // zlyhala z INÉHO dôvodu (dôležité #5) — transakcia sa ROLLBACKOL, takže
    // aj riadok `catalog_snapshot`, ktorý mala zapísať, je preč. Bez tohto by
    // uložené surové bajty (`rawPath`, zapísané ešte PRED touto transakciou)
    // zostali navždy bez záznamu, čo by naň ukazoval — dôkaz na disku, no nič
    // v databáze. Zápis beží MIMO zlyhanej transakcie (v novej, autonómnej) —
    // tá pôvodná je už len na ROLLBACK. Partial unique index pokrýva len
    // `verdict = 'accepted'`, takže tento `rejected` zápis s tým istým
    // `contentSha256` nemôže naraziť naň.
    const reason = `Materializácia katalógu zlyhala. ${CONSEQUENCE}`;
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    log.error(
      { contentSha256, rawPath, rawErrorMessage },
      "materializácia katalógu zlyhala — zapisujem dôkazový záznam",
    );
    // Tento zápis je SAMOSTATNE ohradený (review final-wave-a, položka 7) —
    // beží mimo akejkoľvek transakcie, takže vlastné zlyhanie (napr. výpadok
    // spojenia) by inak nahradilo PÔVODNÚ chybu (skutočný dôvod
    // materializačného zlyhania, ktorý má z `ingestCatalog` uniknúť) tou z
    // tohto dôkazového zápisu. Zlyhanie dôkazového zápisu sa loguje
    // samostatne a PÔVODNÁ chyba unikne bez ohľadu naň.
    try {
      await db.insert(catalogSnapshots).values({
        fetchedAt: options.now,
        lastConfirmedAt: options.now,
        sourceLabel: redactSourceLabel(download.sourceLabel),
        contentSha256,
        byteSize,
        rowCount,
        columns: [...columns],
        verdict: "rejected",
        rejectionReason: reason,
        rawPath,
        variantCount: null,
        productCount: null,
        issueCount: null,
      });
    } catch (evidenceError) {
      const rawEvidenceErrorMessage =
        evidenceError instanceof Error ? evidenceError.message : String(evidenceError);
      log.error(
        { contentSha256, rawPath, rawEvidenceErrorMessage },
        "dôkazový záznam o zlyhanej materializácii sa tiež nepodarilo zapísať",
      );
    }
    throw error;
  }
  return result;
}
