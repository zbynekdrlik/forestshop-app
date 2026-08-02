import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { orders } from "../src/db/schema.js";
import { ingestOrders, type OrdersExportFetcher } from "../src/modules/orders/ingest.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 172: overuje, že "Nevyzdvihnuté zásielky" má z čoho čítať — `email`/
// `phone`/`packageNumber`/`shippingCarrierName` sa objavia na `order` riadku
// PO importe, extrahované NEZÁVISLE od `mapOrderRow`'s item-validácie
// (vydelené od `orders-ingest.integration.test.ts`, aby ani jeden súbor
// nenarástol cez `.claude/rules/testing.md`'s eslint `max-lines: 400`).
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
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-orders-posta-raw-"));
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
  "email",
  "phone",
  "packageNumber",
  "itemName",
  "itemAmount",
  "itemCode",
] as const;

it("naplní email/phone/packageNumber/shippingCarrierName z produktového aj SHIPPING pseudo-riadku", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  const csv = buildCsv(HEADER, [
    {
      code: "20400001",
      date: "2026-06-15 10:30:00",
      statusName: "Vybavuje sa",
      billFullName: "Jan Novak",
      email: "jan@example.sk",
      phone: "+421900123456",
      packageNumber: "EF123456789SK",
      itemName: "Nohavice",
      itemAmount: "1",
      itemCode: "40237/XL",
    },
    // SHIPPING pseudo-riadok — rovnaké objednávkové polia (opakované), meno
    // dopravcu je jeho VLASTNÝ `itemName` — presne toto MUSÍ appka vytiahnuť,
    // hoci `mapOrderRow` tento riadok ako POLOŽKU celý zahodí.
    {
      code: "20400001",
      date: "2026-06-15 10:30:00",
      statusName: "Vybavuje sa",
      billFullName: "Jan Novak",
      email: "jan@example.sk",
      phone: "+421900123456",
      packageNumber: "EF123456789SK",
      itemName: "Kurier",
      itemAmount: "1",
      itemCode: "SHIPPING6",
    },
  ]);

  const result = await ingestOrders(db, {
    fetchExport: fetcherOf(csv),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });
  expect(result.status).toBe("accepted");

  const [row] = await db.select().from(orders).where(eq(orders.externalOrderId, "20400001"));
  expect(row).toBeDefined();
  expect(row?.email).toBe("jan@example.sk");
  expect(row?.phone).toBe("+421900123456");
  expect(row?.packageNumber).toBe("EF123456789SK");
  expect(row?.shippingCarrierName).toBe("Kurier");
});

it("chýbajúce polia sa mapujú na null (objednávka bez SHIPPING riadku, bez telefónu)", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  const csv = buildCsv(HEADER, [
    {
      code: "20400002",
      date: "2026-06-15 10:30:00",
      statusName: "Vybavuje sa",
      billFullName: "Jan Novak",
      email: "",
      phone: "",
      packageNumber: "",
      itemName: "Nohavice",
      itemAmount: "1",
      itemCode: "40237/XL",
    },
  ]);

  await ingestOrders(db, {
    fetchExport: fetcherOf(csv),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });

  const [row] = await db.select().from(orders).where(eq(orders.externalOrderId, "20400002"));
  expect(row?.email).toBeNull();
  expect(row?.phone).toBeNull();
  expect(row?.packageNumber).toBeNull();
  expect(row?.shippingCarrierName).toBeNull();
});

it("re-import OSVIEŽI packageNumber (zásielka dostane číslo neskôr, po prvom importe)", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  const rowOf = (packageNumber: string): Record<string, string> => ({
    code: "20400003",
    date: "2026-06-15 10:30:00",
    statusName: "Vybavuje sa",
    billFullName: "Jan Novak",
    email: "jan@example.sk",
    phone: "",
    packageNumber,
    itemName: "Nohavice",
    itemAmount: "1",
    itemCode: "40237/XL",
  });

  await ingestOrders(db, {
    fetchExport: fetcherOf(buildCsv(HEADER, [rowOf("")])),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });
  const [beforeRow] = await db.select().from(orders).where(eq(orders.externalOrderId, "20400003"));
  expect(beforeRow?.packageNumber).toBeNull();

  await ingestOrders(db, {
    fetchExport: fetcherOf(buildCsv(HEADER, [rowOf("EF999999999SK")])),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });
  const [afterRow] = await db.select().from(orders).where(eq(orders.externalOrderId, "20400003"));
  expect(afterRow?.packageNumber).toBe("EF999999999SK");
});
