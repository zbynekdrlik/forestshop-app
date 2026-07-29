import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, expect, it } from "vitest";
import { INGEST_ADVISORY_LOCK_KEY, ingestCatalog, type ExportFetcher } from "../src/modules/catalog/ingest.js";
import { DEFAULT_SNAPSHOT_LIMITS, REQUIRED_COLUMNS } from "../src/modules/catalog/validation.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";

// Vydelené z `catalog-ingest.integration.test.ts` do vlastného súboru (review
// final-wave-a, položka 3) — pridanie tohto testu tam pretlačilo súbor cez
// ESLint `max-lines` (400).

const TEST_LIMITS = { ...DEFAULT_SNAPSHOT_LIMITS, minByteSize: 1_000, absoluteMinRows: 10 };

const NOW = new Date("2026-07-29T10:00:00Z");
const NESKOR = new Date("2026-07-30T10:00:00Z");

/**
 * Malý syntetický export s presne `count` platnými, jedinečnými riadkami —
 * potrebujeme dva exporty rôznej veľkosti, ktoré sa dajú spracovať RÝCHLO
 * (žiadne zalomenia riadkov v bunkách, žiadne cp1250 diakritické znaky), aby
 * dva súbežné importy naozaj pretekali o zámok namiesto toho, aby na seba
 * čakali na parsovaní 54 kB reálnej fixtúry. Stĺpce sú presne
 * `REQUIRED_COLUMNS` (žiaden iný stĺpec nie je pre `mapRow`/bránu potrebný),
 * plus koncová bodkočiarka ako v reálnom exporte.
 */
function buildSyntheticCsv(count: number, prefix: string): Buffer {
  const header = `${REQUIRED_COLUMNS.join(";")};`;
  const rows: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const values: Record<string, string> = {
      code: `${prefix}-${String(i)}`,
      guid: `${prefix}-guid-${String(i)}`,
      pairCode: "",
      name: `Test produkt ${String(i)}`,
      supplier: "",
      price: "10,00",
      standardPrice: "",
      purchasePrice: "",
      currency: "EUR",
      includingVat: "1",
      percentVat: "20",
      actionPrice: "",
      actionFrom: "",
      actionUntil: "",
      stock: "1",
      availabilityInStock: "Skladom",
      availabilityOutOfStock: "Skladom",
      productVisibility: "visible",
      variantVisibility: "visible",
    };
    rows.push(`${REQUIRED_COLUMNS.map((c) => values[c] ?? "").join(";")};`);
  }
  return Buffer.from(`${header}\r\n${rows.join("\r\n")}\r\n`, "utf-8");
}

let close: (() => Promise<void>) | undefined;
let rawDir: string | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  if (rawDir !== undefined) await rm(rawDir, { recursive: true, force: true });
  rawDir = undefined;
});

async function boot(): Promise<{ db: Awaited<ReturnType<typeof withCleanDb>>["db"]; dir: string }> {
  const ctx = await withCleanDb();
  close = ctx.close;
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-raw-"));
  return { db: ctx.db, dir: rawDir };
}

function fetcherOf(body: Buffer): ExportFetcher {
  return () => Promise.resolve({ body, sourceLabel: "fixtúra" });
}

// Important #6 (review final-wave-a, položka 3): brána čítala predchádzajúci
// prijatý snapshot a volala `judgeSnapshot` PRED otvorením transakcie, teda
// pred získaním `pg_advisory_xact_lock`. Dva súbežné importy (napr. tlačidlo
// na webe + príkazový riadok naraz) preto mohli posudzovať proti ROVNAKÉMU
// (starému) základu, aj keď jeden z nich medzitým commitol nový, väčší
// základ — malý export, ktorý by postupne (jeden po druhom) bol odmietnutý,
// tak mohol prejsť, a po commite by blanketový update označil tisíce
// variantov druhého importu ako chýbajúce.
//
// Test to dokazuje DETERMINISTICKY, bez spoliehania sa na časovanie: manuálne
// (z druhého pripojenia) podrží ROVNAKÝ zámok, aký `ingestCatalog` berie ako
// prvý príkaz transakcie (`pg_advisory_lock`/`pg_advisory_xact_lock` zdieľajú
// jeden priestor zámkov bez ohľadu na to, ktorá funkcia zámok vzala). Malý
// import sa tak spoľahlivo zasekne PRESNE na mieste zámku — a až POTOM test
// vloží (mimo `ingestCatalog`, priamo) nový, väčší prijatý snapshot, ktorý
// simuluje "druhý import, čo práve stihol commitnúť". Ak brána číta základ AŽ
// PO získaní zámku (oprava), malý import musí vidieť tento nový, väčší základ
// a byť odmietnutý. Ak by ho čítala pred zámkom (pôvodná chyba), videla by
// starý (menší) základ spred vloženia a bol by nesprávne prijatý.
it("základ pre bránu prijatia sa číta AŽ PO získaní advisory zámku, nie pred otvorením transakcie", async () => {
  const { db, dir } = await boot();

  // `fetchedAt` musí byť STRICTNE skôr než pri druhom vloženom snapshote
  // nižšie — `insertTestSnapshot`'s default je pre oba rovnaký literál, a
  // rovnaký `fetchedAt` by nechal rozhodnúť sekundárny tie-break `desc(id)`
  // (náhodné UUID), takže by tento test bol nedeterministický nezávisle od
  // opravy, ktorú má dokazovať.
  await insertTestSnapshot(db, {
    verdict: "accepted",
    rowCount: 100,
    contentSha256: "sha-lock-test-baseline-100",
    fetchedAt: NOW,
  });

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("Integračné testy potrebujú DATABASE_URL");
  }
  const lockHolder = new pg.Client({ connectionString: databaseUrl });
  await lockHolder.connect();
  await lockHolder.query("select pg_advisory_lock($1)", [INGEST_ADVISORY_LOCK_KEY]);

  try {
    // 90 riadkov: proti starému základu (100, podlaha 80) by prešiel; proti
    // novému základu (1000, podlaha 800), ktorý test o chvíľu vloží, musí
    // byť odmietnutý.
    const smallImport = ingestCatalog(db, {
      fetchExport: fetcherOf(buildSyntheticCsv(90, "small")),
      now: NOW,
      rawDir: dir,
      limits: TEST_LIMITS,
    });

    // Dá malému importu dosť času dôjsť až k `pg_advisory_xact_lock` a
    // zaseknúť sa tam — zámok drží `lockHolder`, takže "príliš neskoro" tu
    // nehrozí, len čakáme, kým sa naň naozaj zasekne.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Simuluje druhý, medzitým commitnutý import s väčším základom — vložené
    // PRIAMO, mimo `ingestCatalog`, presne v momente, keď je malý import
    // zaseknutý na zámku.
    await insertTestSnapshot(db, {
      verdict: "accepted",
      rowCount: 1000,
      contentSha256: "sha-lock-test-concurrent-1000",
      fetchedAt: NESKOR,
    });

    await lockHolder.query("select pg_advisory_unlock($1)", [INGEST_ADVISORY_LOCK_KEY]);
    const result = await smallImport;

    expect(result.status).toBe("rejected");
    // "1000" v dôvode dokazuje, že brána skutočne použila ČERSTVO vložený
    // (väčší) základ, nie ten spred neho (100) — presne to, čo test overuje.
    expect(result.status === "rejected" && result.reason).toContain("1000");
  } finally {
    await lockHolder.end();
  }
});
