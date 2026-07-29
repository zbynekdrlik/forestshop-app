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
import { insertTestSnapshot } from "./helpers/catalog.js";
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

/**
 * Nájde prvý výskyt `fieldMarker` (čisto ASCII, teda kódovanie nehrá rolu) PO
 * `recordCodeMarker` a vloží tam presne jeden bajt 0x00 — reálny Postgres na
 * NUL bajt v `text` stĺpci spoľahlivo a deterministicky vyhodí
 * "invalid byte sequence for encoding "UTF8"" (overené naživo proti lokálnej
 * databáze), čo je presne materializačné zlyhanie potrebné pre Important #5.
 */
function injectNulByteAfter(csv: Buffer, recordCodeMarker: string, fieldMarker: string): Buffer {
  const recordStart = csv.indexOf(Buffer.from(recordCodeMarker, "ascii"));
  if (recordStart === -1) throw new Error(`Marker záznamu "${recordCodeMarker}" sa vo fixtúre nenašiel`);
  const fieldOffset = csv.indexOf(Buffer.from(fieldMarker, "ascii"), recordStart);
  if (fieldOffset === -1) throw new Error(`Marker poľa "${fieldMarker}" sa po zázname nenašiel`);
  const cut = fieldOffset + fieldMarker.length;
  return Buffer.concat([csv.subarray(0, cut), Buffer.from([0x00]), csv.subarray(cut)]);
}

/**
 * Nahradí PRVÉ pole (`code`) v surových bajtoch záznamu prázdnym reťazcom —
 * predpokladá, že pole je jednoducho zacitované, bez escapovaných úvodzoviek
 * vnútri (platí pre všetky kódy v tejto fixtúre).
 */
function blankFirstField(record: Buffer): Buffer {
  const text = record.toString("latin1");
  const match = /^"[^"]*";/.exec(text);
  if (match === null) throw new Error(`Neočakávaný tvar záznamu: ${text.slice(0, 30)}`);
  return Buffer.from('"";' + text.slice(match[0].length), "latin1");
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
    // Identita produktu je `guid` (review task-5-fix-1, CRITICAL #1), nikdy
    // prefix `code` pred lomkou.
    productKey: "0a486205-d9e7-11e0-92ec-e1ef0b66e031",
    guid: "0a486205-d9e7-11e0-92ec-e1ef0b66e031",
    sizeLabel: "3XL",
    price: "62.76",
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

// Important (review final-wave-a, položka 5): duplicitný import predtým
// nezanechal ŽIADNU stopu, že kontrola prebehla — jediný ukazovateľ
// čerstvosti (`fetchedAt`) zamrzol na prvom stiahnutí, hoci naplánovaný
// import každú noc hlási úspech. `lastConfirmedAt` musí posunúť presne
// TÝMTO — a nič iné na riadku sa nesmie zmeniť.
it("duplicitný import posunie čas potvrdenia (lastConfirmedAt), nič iné na riadku sa nezmení", async () => {
  const { db, dir } = await boot();
  await ingestCatalog(db, { fetchExport: fetcherOf(FIXTURE), now: NOW, rawDir: dir, limits: TEST_LIMITS });

  const [poPrvomImporte] = await db.select().from(catalogSnapshots);
  expect(poPrvomImporte?.lastConfirmedAt).toEqual(NOW);

  const result = await ingestCatalog(db, {
    fetchExport: fetcherOf(FIXTURE),
    now: NESKOR,
    rawDir: dir,
    limits: TEST_LIMITS,
  });
  expect(result.status).toBe("duplicate");

  const [poDruhomImporte] = await db.select().from(catalogSnapshots);
  expect(poDruhomImporte?.lastConfirmedAt).toEqual(NESKOR);
  // Všetko OSTATNÉ na riadku ostáva presne také, ako po prvom importe —
  // duplicitná kontrola nesmie prepísať nič iné než potvrdenie čerstvosti.
  expect(poDruhomImporte).toMatchObject({
    id: poPrvomImporte?.id,
    fetchedAt: NOW,
    rowCount: poPrvomImporte?.rowCount,
    variantCount: poPrvomImporte?.variantCount,
    verdict: "accepted",
  });
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

  // Important #5, prvá odrážka (review task-5-fix-1): variant, ktorý sa
  // VRÁTI do exportu, musí prestať byť chýbajúci — jeden znak zlý v
  // dvadsaťpoľovom upserte to potichu a natrvalo pokazí. Tretí import s CELOU
  // pôvodnou fixtúrou (skupina "40237" je späť) — bajt-navyše (nezacitovaný
  // koncový riadok, `parseDelimited` ho ticho ignoruje) mení sha256 oproti
  // PRVÉMU importu, inak by ho dedup (rovnaký obsah = duplicate) zastavil
  // skôr, než by sa dalo overiť značenie `missingSince`.
  const NAJNESKOR = new Date("2026-07-31T10:00:00Z");
  const treti = await ingestCatalog(db, {
    fetchExport: fetcherOf(Buffer.concat([FIXTURE, Buffer.from("\n")])),
    now: NAJNESKOR,
    rawDir: dir,
    limits: TEST_LIMITS,
  });
  expect(treti).toMatchObject({ status: "accepted", variantCount: 35, missingCount: 0 });

  const [vratil] = await db.select().from(variants).where(eq(variants.code, "40237/3XL"));
  expect(vratil?.missingSince).toBeNull();
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

// CRITICAL #2 (review task-5-fix-1): surové bajty sa ukladajú PRED
// parsovaním, takže aj pretrhnuté sťahovanie (súbor sa skončí vnútri
// zacitovanej bunky) musí nechať dôkaz — nikdy nesmie uniknúť ako výnimka.
it("stiahnutie pretrhnuté vnútri zacitovanej bunky sa zapíše ako rejected s dôkazom, nikdy nevyhodí výnimku", async () => {
  const { db, dir } = await boot();
  const { header, records } = splitRecords(FIXTURE);
  const prvyZaznam = records[0];
  if (prvyZaznam === undefined) throw new Error("Fixtúra nemá žiadne záznamy");
  // Odrezané na 30 % dĺžky prvého záznamu — jeho popis je veľký zacitovaný
  // HTML blok, takže rez tam spoľahlivo padne vnútri otvorenej úvodzovky
  // (overené naživo nad touto fixtúrou).
  const utnute = Buffer.concat([header, prvyZaznam.subarray(0, Math.floor(prvyZaznam.length * 0.3))]);

  // Samotné `await` (bez try/catch) je dôkaz, že toto NEVYHODÍ — keby
  // `ingestCatalog` nechal výnimku uniknúť, vitest by test zhodil ako
  // neošetrené zamietnutie promisu.
  const result = await ingestCatalog(db, {
    fetchExport: fetcherOf(utnute),
    now: NOW,
    rawDir: dir,
    limits: TEST_LIMITS,
  });

  expect(result.status).toBe("rejected");
  expect(result.status === "rejected" && result.reason).toContain("nedal prečítať");
  expect(result.status === "rejected" && result.reason).toContain(
    "Katalóg zostáva nezmenený, import môžete kedykoľvek zopakovať.",
  );

  const [snapshot] = await db.select().from(catalogSnapshots);
  expect(snapshot?.verdict).toBe("rejected");
  expect(snapshot?.rawPath).toMatch(/\.csv\.gz$/);
  expect(await db.select().from(variants)).toHaveLength(0);
});

// Important #3 (review task-5-fix-1): brána dostávala len `rowCount`
// (rozparsované riadky), nie počet POUŽITEĽNÝCH záznamov — export, ktorého
// `code` je prázdny na KAŽDOM riadku, tak prešiel a blanketový update by
// označil CELÝ katalóg ako chýbajúci (#277/#286 v novej podobe).
it("export, ktorého code je prázdny na každom riadku, sa odmietne — inak by blanketový update vymazal celý katalóg", async () => {
  const { db, dir } = await boot();
  await ingestCatalog(db, {
    fetchExport: fetcherOf(FIXTURE),
    now: NOW,
    rawDir: dir,
    limits: TEST_LIMITS,
  });

  const { header, records } = splitRecords(FIXTURE);
  const bezKodov = Buffer.concat([header, ...records.map(blankFirstField)]);

  const result = await ingestCatalog(db, {
    fetchExport: fetcherOf(bezKodov),
    now: NESKOR,
    rawDir: dir,
    limits: TEST_LIMITS,
  });

  expect(result.status).toBe("rejected");
  expect(result.status === "rejected" && result.reason).toContain("použiteľný");
  expect(result.status === "rejected" && result.reason).toContain(
    "Katalóg zostáva nezmenený, import môžete kedykoľvek zopakovať.",
  );
  // Katalóg z prvého importu zostal nedotknutý — presne to, čo #277/#286
  // nedokázali.
  expect(await db.select().from(variants)).toHaveLength(35);
  const [nohavice] = await db.select().from(variants).where(eq(variants.code, "40237/3XL"));
  expect(nohavice?.missingSince).toBeNull();
});

// Important #4 (review task-5-fix-1): dva súbežné importy ROVNAKÉHO obsahu.
// Zámok serializuje ich transakcie; druhý, po commite prvého, narazí na
// `catalog_snapshot_accepted_sha_uq` a MUSÍ sa preložiť na `duplicate`, nie na
// uniknutú (nezachytenú) výnimku, ktorá by HTTP vrstve unikla ako 500.
it("dva súbežné importy rovnakého obsahu — presne jeden accepted, druhý duplicate, žiadna neošetrená chyba", async () => {
  const { db, dir } = await boot();

  const [a, b] = await Promise.all([
    ingestCatalog(db, { fetchExport: fetcherOf(FIXTURE), now: NOW, rawDir: dir, limits: TEST_LIMITS }),
    ingestCatalog(db, { fetchExport: fetcherOf(FIXTURE), now: NOW, rawDir: dir, limits: TEST_LIMITS }),
  ]);

  const statuses = [a.status, b.status].sort();
  expect(statuses).toEqual(["accepted", "duplicate"]);
  expect(await db.select().from(catalogSnapshots)).toHaveLength(1);
  expect(await db.select().from(variants)).toHaveLength(35);
  expect(await db.select().from(products)).toHaveLength(8);
});

// Important #5, druhá odrážka (review task-5-fix-1): zlyhanie UPROSTRED
// materializácie (napr. reálna DB chyba) transakciu ROLLBACKNE — aj riadok
// `catalog_snapshot`, ktorý mala zapísať. Bez opravy by uložené surové bajty
// (zapísané ešte PRED transakciou) zostali navždy bez záznamu, čo by naň
// ukazoval. NUL bajt (0x00) v `text` stĺpci spoľahlivo vyhodí reálnu Postgres
// chybu — overené naživo proti lokálnej databáze pred písaním tohto testu.
it("zlyhanie materializácie zapíše dôkazový (rejected) záznam a katalóg zostane nedotknutý", async () => {
  const { db, dir } = await boot();
  await ingestCatalog(db, {
    fetchExport: fetcherOf(FIXTURE),
    now: NOW,
    rawDir: dir,
    limits: TEST_LIMITS,
  });

  const otravena = injectNulByteAfter(FIXTURE, '"40287";"";"', "Polar FOREST");

  await expect(
    ingestCatalog(db, {
      fetchExport: fetcherOf(otravena),
      now: NESKOR,
      rawDir: dir,
      limits: TEST_LIMITS,
    }),
  ).rejects.toThrow();

  // Katalóg z prvého importu zostal nedotknutý.
  expect(await db.select().from(variants)).toHaveLength(35);
  const [nohavice] = await db.select().from(variants).where(eq(variants.code, "40287"));
  expect(nohavice?.lastSeenAt).toEqual(NOW);

  // Dôkazový záznam existuje — druhý snapshot, rejected, s rawPath ukazujúcim
  // na uložené (otrávené) bajty, dôvod v slovenčine s dôsledkovou vetou.
  const snapshots = await db.select().from(catalogSnapshots).orderBy(catalogSnapshots.fetchedAt);
  expect(snapshots).toHaveLength(2);
  const zlyhany = snapshots[1];
  expect(zlyhany?.verdict).toBe("rejected");
  expect(zlyhany?.rawPath).toMatch(/\.csv\.gz$/);
  expect(zlyhany?.rejectionReason).toContain(
    "Katalóg zostáva nezmenený, import môžete kedykoľvek zopakovať.",
  );
});

// Smaller correctness item (review final-wave-a, položka 7): samotný
// dôkazový zápis (vyššie) beží MIMO zlyhanej transakcie ako nechránený
// `await db.insert(...)` — keby zlyhal AJ ON (napr. výpadok spojenia), jeho
// vlastná výnimka by nahradila tú PÔVODNÚ (skutočný dôvod materializačného
// zlyhania), ktorú `ingestCatalog` mal uniknúť. Cielený proxy zlyhá LEN na
// tomto jednom volaní (`db.insert`, mimo transakcie) — `tx.insert` vnútri
// transakcie je úplne iný objekt, takže samotná materializácia prebehne a
// zlyhá presne ako v teste vyššie.
it("keď zlyhá aj dôkazový zápis po zlyhaní materializácie, unikne PÔVODNÁ chyba, nie chyba z dôkazového zápisu", async () => {
  const { db, dir } = await boot();
  await ingestCatalog(db, {
    fetchExport: fetcherOf(FIXTURE),
    now: NOW,
    rawDir: dir,
    limits: TEST_LIMITS,
  });

  const otravena = injectNulByteAfter(FIXTURE, '"40287";"";"', "Polar FOREST");
  const zlyhanieDokazu = new Error("dôkazový zápis zámerne zlyhal (simulácia výpadku spojenia)");
  const zlyhavajuciDb = Object.create(db) as typeof db;
  Object.defineProperty(zlyhavajuciDb, "insert", {
    value: () => {
      throw zlyhanieDokazu;
    },
  });

  await expect(
    ingestCatalog(zlyhavajuciDb, {
      fetchExport: fetcherOf(otravena),
      now: NESKOR,
      rawDir: dir,
      limits: TEST_LIMITS,
    }),
  ).rejects.toThrow(/invalid byte sequence/);
});

// Minor (review task-5-fix-1): služba dôveruje `sourceLabel` od AKÉHOKOĽVEK
// vstreknutého fetchera — ručne napísaný fetcher (napr. budúci alternatívny
// zdroj), ktorý zabudne zavolať `redactUrl`, nesmie dostať živý prihlasovací
// údaj do databázy.
it("sourceLabel s neprekrytým hashom od ručne napísaného fetchera sa prekryje aj v službe", async () => {
  const { db, dir } = await boot();
  const hendrolovanyFetcher: ExportFetcher = () =>
    Promise.resolve({
      body: FIXTURE,
      sourceLabel: "https://www.forestshop.sk/export/products.csv?hash=zive-tajomstvo",
    });

  await ingestCatalog(db, { fetchExport: hendrolovanyFetcher, now: NOW, rawDir: dir, limits: TEST_LIMITS });

  const [snapshot] = await db.select().from(catalogSnapshots);
  expect(snapshot?.sourceLabel).toBe("https://www.forestshop.sk/export/products.csv?hash=***");
  expect(snapshot?.sourceLabel).not.toContain("zive-tajomstvo");
});

// Minor (review task-5-fix-1): dva prijaté snapshoty s ROVNAKÝM `fetchedAt`
// (napr. vstreknuté `now` v teste, alebo dva importy v tej istej milisekunde)
// museli predtým vrátiť poradie, ktoré Postgres negarantuje — `id` ako druhý,
// stabilný tie-break robí výber deterministickým pri každom behu.
it("dva prijaté snapshoty s rovnakým fetchedAt sa vyhodnotia vždy rovnako (stabilný tie-break)", async () => {
  const { db, dir } = await boot();
  const zdielanyCas = new Date("2026-07-28T09:00:00Z");
  const idNizky = await insertTestSnapshot(db, { fetchedAt: zdielanyCas, rowCount: 40 });
  const idVysoky = await insertTestSnapshot(db, { fetchedAt: zdielanyCas, rowCount: 1_000 });

  // `orderBy(desc(fetchedAt), desc(id))` — vyššie (textovo) UUID vyhráva.
  const vitaz = idNizky > idVysoky ? idNizky : idVysoky;
  const vitaznyRowCount = vitaz === idNizky ? 40 : 1_000;
  const ocakavanaHranica = Math.max(
    Math.floor(vitaznyRowCount * TEST_LIMITS.previousRowRatio),
    TEST_LIMITS.absoluteMinRows,
  );

  // Fixtúra má 35 riadkov — výsledok MUSÍ zodpovedať hranici odvodenej z
  // riadku, ktorý tie-break vyberie ako "predchádzajúci prijatý", nie z toho
  // druhého (inak by bol test krehký/nedeterministický).
  const result = await ingestCatalog(db, {
    fetchExport: fetcherOf(FIXTURE),
    now: NOW,
    rawDir: dir,
    limits: TEST_LIMITS,
  });

  expect(result.status).toBe(35 < ocakavanaHranica ? "rejected" : "accepted");
});
