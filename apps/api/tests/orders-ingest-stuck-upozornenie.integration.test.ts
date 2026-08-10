import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { upozornenie } from "../src/db/schema.js";
import { ingestOrders, type OrdersExportFetcher } from "../src/modules/orders/ingest.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariant } from "./helpers/orders.js";
import { buildReturnStatusCsv, RETURN_STATUS_CSV_HEADER } from "./helpers/orders-return-csv.js";

// issue 301: import objednávok vyrobí/obnoví/zatvorí kartu na Upozorneniach
// (#267), keď objednávka dlho visí v nevybavenom stave ("Vybavuje sa"/
// "Nevybavená") — vydelené do VLASTNÉHO súboru (rovnaký dôvod ako
// `orders-ingest-return-upozornenie.integration.test.ts`, `.claude/rules/
// testing.md`'s eslint `max-lines: 400`).
const WINDOW_START = new Date("2020-01-01T00:00:00Z");
const WINDOW_END = new Date("2030-01-01T00:00:00Z");
// Zhoduje sa s ticketom citovaným "dnes" (7. 8. 2026) — najstaršie naživo
// overené "visiace" objednávky boli od 30. 4./7. 5. 2026.
const NOW = new Date("2026-08-07T10:00:00Z");

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
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-orders-stuck-raw-"));
  return { db: ctx.db, dir: rawDir };
}

function fetcherOf(body: Buffer): OrdersExportFetcher {
  return () => Promise.resolve({ body, sourceLabel: "fixtúra" });
}

const HEADER = RETURN_STATUS_CSV_HEADER;
const buildCsv = buildReturnStatusCsv;

// `date` je Europe/Bratislava LOKÁLNY čas (`.claude/rules/orders.md`'s
// `parseShopLocalDateTime`) — testy tu zámerne držia hrubú rezervu (dni, nie
// hodiny) okolo 14-dňového prahu, aby letný UTC+2 posun nikdy nerozhodol o
// výsledku.
function rowOf(code: string, statusName: string, date: string, billFullName = "Ján Novák"): Record<string, string> {
  return { code, date, statusName, billFullName, itemName: "Nohavice", itemAmount: "1", itemCode: "40237/XL" };
}

it("objednávka NEVYBAVENÁ len pár dní (pod prahom) NEVYROBÍ kartu 'visí'", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  await ingestOrders(db, {
    fetchExport: fetcherOf(buildCsv(HEADER, [rowOf("20700001", "Vybavuje sa", "2026-08-01 10:00:00")])),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });

  const rows = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "objednavka-visi:20700001"));
  expect(rows).toHaveLength(0);
});

it("objednávka NEVYBAVENÁ dlhšie než prah vyrobí kartu s číslom, dňami a odkazom do Shoptetu", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  const result = await ingestOrders(db, {
    fetchExport: fetcherOf(buildCsv(HEADER, [rowOf("20700002", "Vybavuje sa", "2026-07-18 10:00:00")])),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    adminBaseUrl: "https://www.forestshop.sk",
  });
  expect(result.status).toBe("accepted");

  const rows = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "objednavka-visi:20700002"));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.type).toBe("objednavka_visi");
  expect(rows[0]?.source).toBe("appka");
  expect(rows[0]?.title).toContain("20700002");
  expect(rows[0]?.title).toContain("20 dní");
  expect(rows[0]?.link).toContain("20700002");
  expect(rows[0]?.resolvedAt).toBeNull();
});

// issue 327: majiteľ nechce kartu za stav "Nevybavená" vôbec — na rozdiel
// od predošlého správania (issue 301, kde OBA nevybavené stavy zakladali
// kartu), tento test teraz overuje presný OPAK.
it("issue 327: objednávka v stave 'Nevybavená' NEVYROBÍ kartu 'visí', hoci prekročila prah", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  await ingestOrders(db, {
    fetchExport: fetcherOf(buildCsv(HEADER, [rowOf("20700003", "Nevybavená", "2026-07-10 10:00:00")])),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });

  const rows = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "objednavka-visi:20700003"));
  expect(rows).toHaveLength(0);
});

// issue 327: existujúca OTVORENÁ karta pre stav "Nevybavená" (založená pred
// touto zmenou, keď ešte tento stav bol súčasťou "nevybavených") sa má
// AUTOMATICKY zatvoriť pri najbližšom importe, žiadny manuálny cleanup
// skript — rovnaký mechanizmus, aký `applyStuckUpozornenia` už používa pre
// prechod do skutočne vybaveného stavu (test nižšie), len teraz spustený aj
// pre "Nevybavená", lebo tá už NIE JE v `UNFINISHED_ORDER_STATUS_NAMES`.
it("issue 327: existujúca otvorená karta 'Vybavuje sa' → 'Nevybavená' sa AUTOMATICKY zatvorí ďalším importom", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  await ingestOrders(db, {
    fetchExport: fetcherOf(buildCsv(HEADER, [rowOf("20700007", "Vybavuje sa", "2026-07-18 10:00:00")])),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });
  const before = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "objednavka-visi:20700007"));
  expect(before).toHaveLength(1);
  expect(before[0]?.resolvedAt).toBeNull();

  await ingestOrders(db, {
    fetchExport: fetcherOf(buildCsv(HEADER, [rowOf("20700007", "Nevybavená", "2026-07-18 10:00:00")])),
    now: new Date("2026-08-08T10:00:00Z"),
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });

  const after = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "objednavka-visi:20700007"));
  expect(after).toHaveLength(1); // stále jedna karta, žiadna nová
  expect(after[0]?.id).toBe(before[0]?.id);
  expect(after[0]?.resolvedAt).not.toBeNull(); // AUTOMATICKY zatvorená
  expect(after[0]?.resolvedByUserId).toBeNull(); // "vybavené systémom", nie ručne
});

it("opakovaný import tej istej stuck objednávky NEVYROBÍ druhú kartu, len obnoví počet dní", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");
  const csv = buildCsv(HEADER, [rowOf("20700004", "Vybavuje sa", "2026-07-18 10:00:00")]);

  await ingestOrders(db, { fetchExport: fetcherOf(csv), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const before = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "objednavka-visi:20700004"));
  expect(before).toHaveLength(1);
  const cardId = before[0]?.id;

  await ingestOrders(db, {
    fetchExport: fetcherOf(csv),
    now: new Date("2026-08-08T10:00:00Z"),
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });

  const after = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "objednavka-visi:20700004"));
  expect(after).toHaveLength(1);
  expect(after[0]?.id).toBe(cardId); // TÁ istá karta, žiadna druhá
  expect(after[0]?.title).toContain("21 dní"); // deň sa posunul, obnovené
});

it("prechod z nevybaveného do vybaveného stavu AUTOMATICKY ZATVORÍ existujúcu kartu", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  await ingestOrders(db, {
    fetchExport: fetcherOf(buildCsv(HEADER, [rowOf("20700005", "Vybavuje sa", "2026-07-18 10:00:00")])),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });
  const before = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "objednavka-visi:20700005"));
  expect(before).toHaveLength(1);
  expect(before[0]?.resolvedAt).toBeNull();

  await ingestOrders(db, {
    fetchExport: fetcherOf(buildCsv(HEADER, [rowOf("20700005", "Vybavená", "2026-07-18 10:00:00")])),
    now: new Date("2026-08-08T10:00:00Z"),
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });

  const after = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "objednavka-visi:20700005"));
  expect(after).toHaveLength(1); // stále jedna karta, žiadna nová
  expect(after[0]?.id).toBe(before[0]?.id);
  expect(after[0]?.resolvedAt).not.toBeNull(); // AUTOMATICKY zatvorená
  expect(after[0]?.resolvedByUserId).toBeNull(); // "vybavené systémom", nie ručne
});

it("objednávka, ktorej PRVÝ import je už vybavený stav, NEVYROBÍ žiadnu kartu", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  await ingestOrders(db, {
    fetchExport: fetcherOf(buildCsv(HEADER, [rowOf("20700006", "Vybavená", "2026-07-01 10:00:00")])),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });

  const rows = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "objednavka-visi:20700006"));
  expect(rows).toHaveLength(0);
});
