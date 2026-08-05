import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { upozornenie, users } from "../src/db/schema.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { ingestOrders, type OrdersExportFetcher } from "../src/modules/orders/ingest.js";
import { resolveUpozornenie } from "../src/modules/upozornenia/service.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariant } from "./helpers/orders.js";
import { encodeCp1250, RETURN_STATUS_CSV_HEADER, buildReturnStatusCsv, returnStatusRowOf } from "./helpers/orders-return-csv.js";

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
// nie ako UTF-8 text. Pomocníky sú od issue 269's TOCTOU zámkového testu
// ZDIEĽANÉ (`./helpers/orders-return-csv.js`), aby ich nemal aj DRUHÝ súbor
// (`orders-ingest-return-upozornenie-lock.integration.test.ts`) stavať
// nezávisle znova.
const HEADER = RETURN_STATUS_CSV_HEADER;
const buildCsv = buildReturnStatusCsv;
const rowOf = returnStatusRowOf;

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

// issue 269 (naživo overenie na 0.3.0-dev.160): vybavené vrátenie je
// KONEČNÉ — na rozdiel od #268's nevyzdvihnutej zásielky sa nesmie NIKDY
// znova ohlásiť, aj keď Shoptet-ov status objednávky ostáva v tom istom
// vrátkovom stave navždy (žiadna budúca zmena ho nikdy nevráti späť).
it("po vybavení karty (Vybavené) opakovaný import UŽ NEVYROBÍ druhú kartu na tú istú objednávku", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");
  const csv = buildCsv(HEADER, [rowOf("20600005", "Vratený tovar")]);

  await ingestOrders(db, { fetchExport: fetcherOf(csv), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const before = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600005"));
  expect(before).toHaveLength(1);
  const cardId = before[0]?.id;
  if (cardId === undefined) throw new Error("karta sa nevyrobila");

  const [user] = await db
    .insert(users)
    .values({ email: "majitel-269@forestshop.sk", passwordHash: await hashPassword("test-heslo-abc"), displayName: "Majiteľ", role: "manazer" })
    .returning({ id: users.id });
  if (user === undefined) throw new Error("test používateľ sa nepodarilo vložiť");
  const resolved = await resolveUpozornenie(db, { id: cardId, resolvedByUserId: user.id, now: new Date("2026-07-31T09:00:00Z") });
  expect(resolved).toBe(true);

  await ingestOrders(db, {
    fetchExport: fetcherOf(csv),
    now: new Date("2026-08-01T10:00:00Z"),
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });

  const after = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600005"));
  expect(after).toHaveLength(1); // presne jedna karta — stále tá vybavená, žiadna nová
  expect(after[0]?.id).toBe(cardId);
  expect(after[0]?.resolvedAt).not.toBeNull();
});

// Code review (issue 269): jediný predošlý test overoval vždy PRESNE JEDNU
// vrátkovú objednávku za beh — ale skutočná nová logika je dávkový `Set`
// (`resolvedReturnDedupKeys`), postavený nad VŠETKÝMI kandidátmi TOHO ISTÉHO
// importu naraz. Tento test dokazuje, že vybavenie JEDNEJ objednávky v dávke
// NEOVPLYVNÍ ostatné — objednávka, čo ešte nie je vybavená, sa naďalej
// normálne obnoví, aj keď je v tom istom CSV/behu ako tá vybavená.
it("v jednom importe s viacerými vrátkovými objednávkami ovplyvní vybavenie LEN tú svoju kartu", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");
  const csv = buildCsv(HEADER, [rowOf("20600008", "Vratený tovar"), rowOf("20600009", "Vybavená výmena")]);

  await ingestOrders(db, { fetchExport: fetcherOf(csv), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const beforeResolved = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600008"));
  const beforeOpen = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600009"));
  expect(beforeResolved).toHaveLength(1);
  expect(beforeOpen).toHaveLength(1);
  const resolvedCardId = beforeResolved[0]?.id;
  const openCardId = beforeOpen[0]?.id;
  if (resolvedCardId === undefined || openCardId === undefined) throw new Error("karty sa nevyrobili");

  const [user] = await db
    .insert(users)
    .values({ email: "majitel-269-dvojica@forestshop.sk", passwordHash: await hashPassword("test-heslo-abc"), displayName: "Majiteľ", role: "manazer" })
    .returning({ id: users.id });
  if (user === undefined) throw new Error("test používateľ sa nepodarilo vložiť");
  expect(await resolveUpozornenie(db, { id: resolvedCardId, resolvedByUserId: user.id, now: new Date("2026-07-31T09:00:00Z") })).toBe(true);

  // Druhý import — rovnaké CSV, obe objednávky ostávajú vo vrátkovom stave.
  await ingestOrders(db, {
    fetchExport: fetcherOf(csv),
    now: new Date("2026-08-01T10:00:00Z"),
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });

  const afterResolved = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600008"));
  expect(afterResolved).toHaveLength(1); // vybavená ostáva vybavená, žiadna nová
  expect(afterResolved[0]?.id).toBe(resolvedCardId);
  expect(afterResolved[0]?.resolvedAt).not.toBeNull();

  const afterOpen = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600009"));
  expect(afterOpen).toHaveLength(1); // stále JEDNA karta, ale STÁLE OBNOVENÁ — nikdy sa nedotkla druhého kandidáta
  expect(afterOpen[0]?.id).toBe(openCardId);
  expect(afterOpen[0]?.resolvedAt).toBeNull();
});
