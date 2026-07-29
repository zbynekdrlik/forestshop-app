import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { catalogSnapshots, ingestIssues, products, variants } from "../src/db/schema.js";
import { ingestCatalog, type ExportFetcher } from "../src/modules/catalog/ingest.js";
import { DEFAULT_SNAPSHOT_LIMITS } from "../src/modules/catalog/validation.js";
import { withCleanDb } from "./helpers/db.js";

const FIXTURE = readFileSync(
  fileURLToPath(new URL("../src/modules/catalog/fixtures/shoptet-sample.csv", import.meta.url)),
);

// Fixtúra má 35 riadkov a ~92 kB — produkčné limity (1 MB, 1 000 riadkov) by ju
// odmietli, tak sa v testoch posúvajú. Pomer 0,8 voči poslednému prijatému
// snapshotu zostáva ten istý ako v produkcii, aby test #277 meral to isté pravidlo.
const TEST_LIMITS = { ...DEFAULT_SNAPSHOT_LIMITS, minByteSize: 1_000, absoluteMinRows: 10 };

const NOW = new Date("2026-07-29T10:00:00Z");
const NESKOR = new Date("2026-07-30T10:00:00Z");

/**
 * Rozdelí bajty exportu na hlavičku a jednotlivé ZÁZNAMY. Delenie po riadkoch by
 * bolo chybné — popisy majú CRLF vnútri úvodzoviek, takže jeden záznam je viac
 * fyzických riadkov. cp1250 je jednobajtové kódovanie a `"`, CR aj LF majú hodnoty
 * pod 0x80, preto sa stav úvodzoviek dá sledovať priamo nad bajtmi (zdvojená
 * úvodzovka prepne stav dvakrát, teda nič nepokazí).
 */
function splitRecords(csv: Buffer): { header: Buffer; records: Buffer[] } {
  const parts: Buffer[] = [];
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < csv.length; i += 1) {
    const byte = csv[i];
    if (byte === 0x22) inQuotes = !inQuotes;
    else if (byte === 0x0a && !inQuotes) {
      parts.push(csv.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < csv.length) parts.push(csv.subarray(start));
  const [header, ...records] = parts;
  if (header === undefined) throw new Error("Fixtúra je prázdna");
  return { header, records };
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

it("prijme fixtúru a naplní produkty aj varianty", async () => {
  const { db, dir } = await boot();

  const result = await ingestCatalog(db, {
    fetchExport: fetcherOf(FIXTURE),
    now: NOW,
    rawDir: dir,
    limits: TEST_LIMITS,
  });

  expect(result.status).toBe("accepted");
  expect(result).toMatchObject({ variantCount: 35, productCount: 8, missingCount: 0 });

  expect(await db.select().from(variants)).toHaveLength(35);
  expect(await db.select().from(products)).toHaveLength(8);

  const [snapshot] = await db.select().from(catalogSnapshots);
  expect(snapshot?.verdict).toBe("accepted");
  expect(snapshot?.rowCount).toBe(35);
  expect(snapshot?.rejectionReason).toBeNull();
  expect(snapshot?.columns).toHaveLength(265);
  expect(snapshot?.rawPath).toMatch(/\.csv\.gz$/);

  const [nohavice] = await db.select().from(variants).where(eq(variants.code, "40237/3XL"));
  expect(nohavice).toMatchObject({
    productKey: "40237",
    sizeLabel: "3XL",
    price: "67.00",
    currency: "EUR",
    stock: -11,
    state: "discontinued",
    missingSince: null,
  });
});

it("odvodí tri stavy dostupnosti presne podľa textov v exporte", async () => {
  const { db, dir } = await boot();
  await ingestCatalog(db, {
    fetchExport: fetcherOf(FIXTURE),
    now: NOW,
    rawDir: dir,
    limits: TEST_LIMITS,
  });

  const rows = await db.select({ code: variants.code, state: variants.state }).from(variants);
  const byState = { sellable: 0, out_of_stock: 0, discontinued: 0 };
  for (const row of rows) byState[row.state] += 1;
  expect(byState).toEqual({ sellable: 6, out_of_stock: 4, discontinued: 25 });

  const state = (code: string): string | undefined => rows.find((r) => r.code === code)?.state;
  expect(state("40237/M")).toBe("sellable");
  expect(state("278")).toBe("out_of_stock");
  expect(state("BR1611")).toBe("discontinued");
});

it("ten istý obsah sa druhýkrát nespracuje", async () => {
  const { db, dir } = await boot();
  const first = await ingestCatalog(db, {
    fetchExport: fetcherOf(FIXTURE),
    now: NOW,
    rawDir: dir,
    limits: TEST_LIMITS,
  });
  const second = await ingestCatalog(db, {
    fetchExport: fetcherOf(FIXTURE),
    now: NESKOR,
    rawDir: dir,
    limits: TEST_LIMITS,
  });

  expect(second.status).toBe("duplicate");
  expect(second.snapshotId).toBe(first.snapshotId);
  expect(await db.select().from(catalogSnapshots)).toHaveLength(1);
});

it("variant, ktorý z exportu zmizne, sa nemaže — len sa označí odkedy chýba", async () => {
  const { db, dir } = await boot();
  await ingestCatalog(db, {
    fetchExport: fetcherOf(FIXTURE),
    now: NOW,
    rawDir: dir,
    limits: TEST_LIMITS,
  });

  // Druhý export bez skupiny 40237 (9 variantov) — inak bajt na bajt identický.
  const { header, records } = splitRecords(FIXTURE);
  const bezNohavic = Buffer.concat([
    header,
    ...records.filter((r) => !r.subarray(0, 10).toString("latin1").startsWith('"40237/')),
  ]);

  // Odstránená skupina "40237" je 9 z 35 riadkov (74 % zostáva) — pod
  // produkčným pomerom 0,8 (floor 28), ktorý tento test zámerne netestuje (to
  // robí validation.test.ts pre #277); tu sa testuje len značenie
  // `missingSince`. Preto sa pomer pre TENTO druhý import znižuje, aby scenár
  // vôbec prešiel bránou a dal sa overiť.
  const result = await ingestCatalog(db, {
    fetchExport: fetcherOf(bezNohavic),
    now: NESKOR,
    rawDir: dir,
    limits: { ...TEST_LIMITS, previousRowRatio: 0.5 },
  });

  expect(result).toMatchObject({ status: "accepted", variantCount: 26, missingCount: 9 });
  expect(await db.select().from(variants)).toHaveLength(35);

  const [zmiznuty] = await db.select().from(variants).where(eq(variants.code, "40237/3XL"));
  expect(zmiznuty?.missingSince).toEqual(NESKOR);
  const [ostal] = await db.select().from(variants).where(eq(variants.code, "40287"));
  expect(ostal?.missingSince).toBeNull();
});

it("odmietnutý export sa zapíše a katalóg zostane nedotknutý (#281)", async () => {
  const { db, dir } = await boot();
  await ingestCatalog(db, {
    fetchExport: fetcherOf(FIXTURE),
    now: NOW,
    rawDir: dir,
    limits: TEST_LIMITS,
  });

  // Ten istý export, len bez stĺpca `supplier` v HLAVIČKE — presne tvar #281, kde
  // plnohodnotný export prešiel, lebo sa stĺpce nekontrolovali. Prevod cez latin1 je
  // bajt-verný (jeden bajt = jeden znak), takže zvyšok hlavičky zostáva nedotknutý.
  const { header, records } = splitRecords(FIXTURE);
  const bezDodavatela = Buffer.concat([
    Buffer.from(header.toString("latin1").replace(";supplier;", ";"), "latin1"),
    ...records,
  ]);

  const result = await ingestCatalog(db, {
    fetchExport: fetcherOf(bezDodavatela),
    now: NESKOR,
    rawDir: dir,
    limits: TEST_LIMITS,
  });

  expect(result.status).toBe("rejected");
  expect(result.status === "rejected" && result.reason).toContain("supplier");

  const snapshots = await db.select().from(catalogSnapshots);
  expect(snapshots).toHaveLength(2);
  expect(snapshots.filter((s) => s.verdict === "rejected")).toHaveLength(1);
  // Katalóg sa nepohol — presne to, čo #281 nedokázalo.
  expect(await db.select().from(variants)).toHaveLength(35);
  const [nohavice] = await db.select().from(variants).where(eq(variants.code, "40237/3XL"));
  expect(nohavice?.lastSeenAt).toEqual(NOW);
});

it("prázdne telo je odmietnuté a zapísané (#286)", async () => {
  const { db, dir } = await boot();
  const result = await ingestCatalog(db, {
    fetchExport: fetcherOf(Buffer.alloc(0)),
    now: NOW,
    rawDir: dir,
    limits: TEST_LIMITS,
  });

  expect(result.status).toBe("rejected");
  expect(result.status === "rejected" && result.reason).toContain("prázdny");
  expect(await db.select().from(variants)).toHaveLength(0);
  expect(await db.select().from(catalogSnapshots)).toHaveLength(1);
});

it("duplicitný kód v exporte nezhodí import, len sa zapíše ako anomália", async () => {
  const { db, dir } = await boot();
  const { header, records } = splitRecords(FIXTURE);
  const prvy = records[0];
  if (prvy === undefined) throw new Error("Fixtúra nemá žiadne záznamy");
  const sDuplikatom = Buffer.concat([header, prvy, ...records]);

  const result = await ingestCatalog(db, {
    fetchExport: fetcherOf(sDuplikatom),
    now: NOW,
    rawDir: dir,
    limits: TEST_LIMITS,
  });

  expect(result).toMatchObject({ status: "accepted", variantCount: 35, issueCount: 1 });
  const issues = await db.select().from(ingestIssues);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({ kind: "duplicate_code", code: "40237/3XL", at: NOW });
});
