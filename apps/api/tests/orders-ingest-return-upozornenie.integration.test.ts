import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { upozornenie } from "../src/db/schema.js";
import { ingestOrders, type OrdersExportFetcher } from "../src/modules/orders/ingest.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 269: import objednávok vyrobí/obnoví kartu na Upozorneniach (#267),
// keď objednávka prejde do vrátkového stavu — vydelené do VLASTNÉHO súboru
// (rovnaký dôvod ako `orders-ingest-posta-fields.integration.test.ts`,
// `.claude/rules/testing.md`'s eslint `max-lines: 400`).
const WINDOW_START = new Date("2020-01-01T00:00:00Z");
const WINDOW_END = new Date("2030-01-01T00:00:00Z");
const NOW = new Date("2026-07-30T10:00:00Z");

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
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-orders-return-raw-"));
  return { db: ctx.db, dir: rawDir };
}

function fetcherOf(body: Buffer): OrdersExportFetcher {
  return () => Promise.resolve({ body, sourceLabel: "fixtúra" });
}

// `ingestOrders` VŽDY dekóduje ako windows-1250 (`decodeCp1250`) — na rozdiel
// od `orders-ingest.integration.test.ts`'s ASCII-only `buildCsv` (ktorá by
// diakritiku pri UTF-8 zápise na druhej strane pokazila, `.claude/rules/
// orders.md`), tento súbor POTREBUJE reálne vrátkové stavy s diakritikou
// ("Vratený tovar" a pod.) — preto sa CSV zapisuje priamo ako cp1250 BYTES,
// nie ako UTF-8 text. Kódovaciu tabuľku (znak → byte) staviame DYNAMICKY
// dekódovaním všetkých 256 bajtov cez `TextDecoder("windows-1250")` a
// obrátením mapy — žiadna nová závislosť (`iconv-lite`), žiadna ručne
// prepisovaná tabuľka kódových bodov.
const CP1250_ENCODE: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  for (let byte = 0; byte < 256; byte += 1) {
    const ch = new TextDecoder("windows-1250").decode(Buffer.from([byte]));
    if (!map.has(ch)) map.set(ch, byte);
  }
  return map;
})();

function encodeCp1250(text: string): Buffer {
  return Buffer.from(Uint8Array.from([...text].map((ch) => CP1250_ENCODE.get(ch) ?? 0x3f)));
}

function buildCsv(header: readonly string[], rows: readonly Record<string, string>[]): Buffer {
  const esc = (v: string): string => `"${v.replaceAll('"', '""')}"`;
  const lines = [header.map(esc).join(";") + ";"];
  for (const row of rows) {
    lines.push(header.map((c) => esc(row[c] ?? "")).join(";") + ";");
  }
  return encodeCp1250(lines.join("\r\n") + "\r\n");
}

const HEADER = ["code", "date", "statusName", "billFullName", "itemName", "itemAmount", "itemCode"] as const;

function rowOf(code: string, statusName: string): Record<string, string> {
  return {
    code,
    date: "2026-06-15 10:30:00",
    statusName,
    billFullName: "Ján Novák",
    itemName: "Nohavice",
    itemAmount: "1",
    itemCode: "40237/XL",
  };
}

it("encodeCp1250 je verný inverzný krok voči appkinmu decodeCp1250 (sebakontrola fixtúry)", () => {
  const original = "Vratený tovar — Vybavená výmena — Vybavený Dobropis";
  expect(new TextDecoder("windows-1250").decode(encodeCp1250(original))).toBe(original);
});

it("objednávka v nevrátkovom stave NEVYROBÍ kartu na Upozorneniach", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  await ingestOrders(db, {
    fetchExport: fetcherOf(buildCsv(HEADER, [rowOf("20600001", "Stornovaná")])),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });

  const rows = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600001"));
  expect(rows).toHaveLength(0);
});

it("objednávka vo vrátkovom stave vyrobí kartu s odkazom na objednávku, nikdy sa nezatvorí sama", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  const result = await ingestOrders(db, {
    fetchExport: fetcherOf(buildCsv(HEADER, [rowOf("20600002", "Vratený tovar")])),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    adminBaseUrl: "https://www.forestshop.sk",
  });
  expect(result.status).toBe("accepted");

  const rows = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600002"));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.type).toBe("vratenie");
  expect(rows[0]?.source).toBe("appka");
  expect(rows[0]?.title).toContain("20600002");
  expect(rows[0]?.title).toContain("vrátený tovar");
  expect(rows[0]?.link).toContain("20600002");
  expect(rows[0]?.resolvedAt).toBeNull();
});

it("opakovaný import tej istej objednávky v tom istom vrátkovom stave NEVYROBÍ druhú kartu, len ju obnoví", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");
  const csv = buildCsv(HEADER, [rowOf("20600003", "Vybavená výmena")]);

  await ingestOrders(db, { fetchExport: fetcherOf(csv), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  await ingestOrders(db, {
    fetchExport: fetcherOf(csv),
    now: new Date("2026-07-31T10:00:00Z"),
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });

  const rows = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600003"));
  expect(rows).toHaveLength(1);
});

it("prechod z jedného vrátkového stavu do druhého (Vratený tovar -> Vybavený Dobropis) OBNOVÍ tú istú kartu, nikdy druhú", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  await ingestOrders(db, {
    fetchExport: fetcherOf(buildCsv(HEADER, [rowOf("20600004", "Vratený tovar")])),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });
  const before = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600004"));
  expect(before).toHaveLength(1);
  expect(before[0]?.title).toContain("vrátený tovar");

  await ingestOrders(db, {
    fetchExport: fetcherOf(buildCsv(HEADER, [rowOf("20600004", "Vybavený Dobropis")])),
    now: new Date("2026-07-31T10:00:00Z"),
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });
  const after = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600004"));
  expect(after).toHaveLength(1); // stále JEDNA karta na objednávku, nikdy druhá pre nový pod-stav
  expect(after[0]?.id).toBe(before[0]?.id);
  expect(after[0]?.title).toContain("vybavený dobropis");
});
