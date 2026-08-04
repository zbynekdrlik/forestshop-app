import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { orders } from "../src/db/schema.js";
import { ingestOrders, type OrdersExportFetcher } from "../src/modules/orders/ingest.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 237: `totalPriceWithVat` (celková suma objednávky s DPH, dashboardová
// tržba `orders/overview.ts`) je VŽDY Shoptetovo pole (rovnaká rodina ako
// `remark`/`shop_remark`/`status_name`, `orders-ingest.integration.test.ts`)
// — re-import ho MUSÍ osviežiť. Vydelené do vlastného súboru (rovnaký dôvod/
// vzor ako `orders-ingest-posta-fields.integration.test.ts`'s split), aby
// pridanie tohto testu neposlalo `orders-ingest.integration.test.ts` cez
// eslint `max-lines: 400`.
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
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-orders-total-price-raw-"));
  return { db: ctx.db, dir: rawDir };
}

function fetcherOf(body: Buffer): OrdersExportFetcher {
  return () => Promise.resolve({ body, sourceLabel: "fixtúra" });
}

// Rovnaký ASCII-only dôvod ako `orders-ingest.integration.test.ts`'s
// `buildCsv` (`.claude/rules/orders.md`) — `ingestOrders` vždy dekóduje ako
// windows-1250, diakritika priamo tu by na druhej strane vyšla pokazená.
function buildCsv(header: readonly string[], rows: readonly Record<string, string>[]): Buffer {
  const esc = (v: string): string => `"${v.replaceAll('"', '""')}"`;
  const lines = [header.map(esc).join(";") + ";"];
  for (const row of rows) {
    lines.push(header.map((c) => esc(row[c] ?? "")).join(";") + ";");
  }
  return Buffer.from(lines.join("\r\n") + "\r\n", "utf-8");
}

const HEADER = [
  "code",
  "date",
  "statusName",
  "billFullName",
  "itemName",
  "itemAmount",
  "itemCode",
  "totalPriceWithVat",
] as const;

it("totalPriceWithVat je Shoptetovo pole a re-import ho osvieži, keď sa suma v Shoptete zmení", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  const bezSumy = buildCsv(HEADER, [
    { code: "9104", date: "2026-07-01 10:00:00", statusName: "Vybavuje sa", billFullName: "X", itemName: "Y", itemAmount: "1", itemCode: "40237/XL" },
  ]);
  await ingestOrders(db, { fetchExport: fetcherOf(bezSumy), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const [prvyRead] = await db.select().from(orders).where(eq(orders.externalOrderId, "9104"));
  expect(prvyRead?.totalPriceWithVat).toBeNull();

  const sSumou = buildCsv(HEADER, [
    {
      code: "9104",
      date: "2026-07-01 10:00:00",
      statusName: "Vybavuje sa",
      billFullName: "X",
      itemName: "Y",
      itemAmount: "1",
      itemCode: "40237/XL",
      totalPriceWithVat: "238,20",
    },
  ]);
  await ingestOrders(db, { fetchExport: fetcherOf(sSumou), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const [druhyRead] = await db.select().from(orders).where(eq(orders.externalOrderId, "9104"));
  expect(druhyRead?.totalPriceWithVat).toBe("238.20");

  // Ďalší re-import s inou sumou musí OSVIEŽIŤ (nikdy nezachovať starú).
  const inaSuma = buildCsv(HEADER, [
    {
      code: "9104",
      date: "2026-07-01 10:00:00",
      statusName: "Vybavuje sa",
      billFullName: "X",
      itemName: "Y",
      itemAmount: "1",
      itemCode: "40237/XL",
      totalPriceWithVat: "199,90",
    },
  ]);
  await ingestOrders(db, { fetchExport: fetcherOf(inaSuma), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const [tretiRead] = await db.select().from(orders).where(eq(orders.externalOrderId, "9104"));
  expect(tretiRead?.totalPriceWithVat).toBe("199.90");
});

it("chýbajúci/nečitateľný totalPriceWithVat sa uloží ako null, nikdy nezhodí import", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  const neplatnaSuma = buildCsv(HEADER, [
    {
      code: "9105",
      date: "2026-07-01 10:00:00",
      statusName: "Vybavuje sa",
      billFullName: "X",
      itemName: "Y",
      itemAmount: "1",
      itemCode: "40237/XL",
      totalPriceWithVat: "neplatna hodnota",
    },
  ]);
  const result = await ingestOrders(db, { fetchExport: fetcherOf(neplatnaSuma), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  expect(result.status).toBe("accepted");
  const [read] = await db.select().from(orders).where(eq(orders.externalOrderId, "9105"));
  expect(read?.totalPriceWithVat).toBeNull();
});
