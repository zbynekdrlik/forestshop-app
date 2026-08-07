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
  const csv = buildCsv(HEADER, [rowOf("20600003", "Vratený tovar")]);

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

// issue 297 (šéf, cez majiteľa): "Vybavená výmena"/"Vybavený Dobropis" sú
// HOTOVÉ stavy — majiteľ nepotrebuje upozornenie na prácu, ktorú niekto už
// spravil. Prechod objednávky z AKTÍVNEHO ("Vratený tovar") do HOTOVÉHO
// stavu preto existujúcu otvorenú kartu AUTOMATICKY ZATVORÍ (rovnaký princíp
// ako #268's doručená zásielka), NIKDY neobnoví jej titulok na nový pod-stav
// (predošlé správanie pred #297).
it("prechod z AKTÍVNEHO stavu do HOTOVÉHO (Vratený tovar -> Vybavený Dobropis) AUTOMATICKY ZATVORÍ existujúcu kartu", async () => {
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
  expect(before[0]?.resolvedAt).toBeNull();

  await ingestOrders(db, {
    fetchExport: fetcherOf(buildCsv(HEADER, [rowOf("20600004", "Vybavený Dobropis")])),
    now: new Date("2026-07-31T10:00:00Z"),
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });
  const after = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600004"));
  expect(after).toHaveLength(1); // stále JEDNA karta na objednávku, žiadna druhá
  expect(after[0]?.id).toBe(before[0]?.id); // TÁ istá karta — zatvorená, nie nová
  expect(after[0]?.resolvedAt).not.toBeNull(); // AUTOMATICKY zatvorená
  expect(after[0]?.resolvedByUserId).toBeNull(); // "vybavené systémom", nie ručne
  expect(after[0]?.title).toBe(before[0]?.title); // titulok sa NIKDY neobnoví na nový pod-stav
});

// issue 297: objednávka, ktorej PRVÝ zistený stav je už HOTOVÝ (nikdy predtým
// nebola "Vratený tovar", teda nikdy nedostala kartu) NEVYROBÍ žiadnu — na
// rozdiel od `classifyReturnStatus`'s aktívnych stavov, `autoResolveByDedupKey`
// je bezpečný no-op, keď žiadna nevyriešená karta pre `dedupKey` neexistuje.
it("objednávka, ktorej PRVÝ import je už HOTOVÝ vrátkový stav, NEVYROBÍ žiadnu kartu", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");

  await ingestOrders(db, {
    fetchExport: fetcherOf(buildCsv(HEADER, [rowOf("20600010", "Vybavená výmena")])),
    now: NOW,
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });

  const rows = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600010"));
  expect(rows).toHaveLength(0);
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
//
// Code review (druhé kolo, finding 6): PÔVODNÁ verzia posielala v OBOCH
// importoch ÚPLNE ROVNAKÉ CSV — otvorená objednávka tak pri druhom importe
// len prepísala svoju kartu BYTE-ZHODNÝMI hodnotami, takže by asercia nižšie
// prešla, AJ keby bol skip "všetko alebo nič za celú dávku" (t.j. AJ keby
// druhý kandidát bol OMYLOM preskočený spolu s prvým — jeho karta by
// jednoducho zostala na SVOJICH pôvodných hodnotách, ktoré sú zhodné s tým,
// čo by upsert aj tak zapísal). Fix: druhý import posiela otvorenej
// objednávke INÉ meno zákazníka (issue 297 nechalo len JEDEN AKTÍVNY
// vrátkový stav — "Vybavená výmena"/"Vybavený Dobropis" boli predtým druhý
// pod-stav použitý na ten istý dôkaz, dnes už HOTOVÉ a mimo `returnCandidates`
// úplne), takže test genuinely OVERUJE, že jej `details` sa SKUTOČNE ZMENILI —
// dôkaz, že bola upsertnutá, nie preskočená. Overené AJ opačným smerom
// (`regression-test-first.md`): dočasná úprava kódu na "preskoč VŠETKÝCH
// kandidátov v dávke, ak je čo i len JEDEN vyriešený" spadla presne na
// asercii `details` otvorenej karty nižšie, návrat opravy prešiel znova.
it("v jednom importe s viacerými vrátkovými objednávkami ovplyvní vybavenie LEN tú svoju kartu", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");
  const csv = buildCsv(HEADER, [rowOf("20600008", "Vratený tovar"), rowOf("20600009", "Vratený tovar")]);

  await ingestOrders(db, { fetchExport: fetcherOf(csv), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const beforeResolved = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600008"));
  const beforeOpen = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600009"));
  expect(beforeResolved).toHaveLength(1);
  expect(beforeOpen).toHaveLength(1);
  expect(beforeOpen[0]?.details).toContain("Ján Novák");
  const resolvedCardId = beforeResolved[0]?.id;
  const openCardId = beforeOpen[0]?.id;
  if (resolvedCardId === undefined || openCardId === undefined) throw new Error("karty sa nevyrobili");

  const [user] = await db
    .insert(users)
    .values({ email: "majitel-269-dvojica@forestshop.sk", passwordHash: await hashPassword("test-heslo-abc"), displayName: "Majiteľ", role: "manazer" })
    .returning({ id: users.id });
  if (user === undefined) throw new Error("test používateľ sa nepodarilo vložiť");
  expect(await resolveUpozornenie(db, { id: resolvedCardId, resolvedByUserId: user.id, now: new Date("2026-07-31T09:00:00Z") })).toBe(true);

  // Druhý import — vybavená objednávka ostáva v tom istom stave (irelevantné,
  // je preskočená), otvorená objednávka dostane INÉ meno zákazníka.
  const csvSecondImport = buildCsv(HEADER, [rowOf("20600008", "Vratený tovar"), rowOf("20600009", "Vratený tovar", "Eva Kováčová")]);
  await ingestOrders(db, {
    fetchExport: fetcherOf(csvSecondImport),
    now: new Date("2026-08-01T10:00:00Z"),
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });

  const afterResolved = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600008"));
  expect(afterResolved).toHaveLength(1); // vybavená ostáva vybavená, žiadna nová
  expect(afterResolved[0]?.id).toBe(resolvedCardId);
  expect(afterResolved[0]?.resolvedAt).not.toBeNull();
  expect(afterResolved[0]?.details).toContain("Ján Novák"); // nedotknutá — stále pôvodné meno, nikdy neupsertnutá

  const afterOpen = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600009"));
  expect(afterOpen).toHaveLength(1); // stále JEDNA karta, ale STÁLE OBNOVENÁ — nikdy sa nedotkla druhého kandidáta
  expect(afterOpen[0]?.id).toBe(openCardId);
  expect(afterOpen[0]?.resolvedAt).toBeNull();
  expect(afterOpen[0]?.details).toContain("Eva Kováčová"); // SKUTOČNE ZMENENÉ meno — dôkaz upsertu, nie preskočenia
});

// issue 297: kľúč, ktorý má SÚČASNE vyriešený AJ otvorený riadok (presne
// stav, aký pôvodný bug na 0.3.0-dev.160 vyrobil) — keď objednávka prejde do
// HOTOVÉHO stavu, `autoResolveByDedupKey`'s `WHERE resolved_at IS NULL`
// zatvorí LEN otvorený súrodenec, nikdy sa nedotkne už vyriešeného (a
// nevyrobí tretí riadok). Scenár sa simuluje priamym vložením OBOCH riadkov
// (nie cez appku — appka takýto stav sama nevyrobí), presne ako by ho
// zanechal historický bug/manuálny zásah.
it("otvorený súrodenec vedľa vyriešeného sa PRI PRECHODE DO HOTOVÉHO STAVU tiež ZATVORÍ, nikdy nezostane navždy otvorený", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");
  const dedupKey = "vratenie:20600200";

  const [resolvedRow] = await db
    .insert(upozornenie)
    .values({
      type: "vratenie",
      source: "appka",
      title: "Objednávka 20600200 — vrátený tovar (staršia, už vybavená)",
      details: "historický riadok",
      dedupKey,
      resolvedAt: new Date("2026-06-01T09:00:00Z"),
      createdAt: new Date("2026-05-30T09:00:00Z"),
    })
    .returning({ id: upozornenie.id });
  const [openRow] = await db
    .insert(upozornenie)
    .values({
      type: "vratenie",
      source: "appka",
      title: "Objednávka 20600200 — vrátený tovar",
      details: "otvorený súrodenec",
      dedupKey,
      resolvedAt: null,
      createdAt: new Date("2026-07-01T09:00:00Z"),
    })
    .returning({ id: upozornenie.id });
  if (resolvedRow === undefined || openRow === undefined) throw new Error("nepodarilo sa nasadiť scenár historického bugu");

  await ingestOrders(db, {
    fetchExport: fetcherOf(buildCsv(HEADER, [rowOf("20600200", "Vybavená výmena")])),
    now: new Date("2026-08-01T10:00:00Z"),
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });

  const rows = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, dedupKey));
  expect(rows).toHaveLength(2); // stále dva riadky — žiadny tretí (nový) nevznikol

  const resolvedAfter = rows.find((r) => r.id === resolvedRow.id);
  expect(resolvedAfter?.resolvedAt).not.toBeNull();
  expect(resolvedAfter?.title).toBe("Objednávka 20600200 — vrátený tovar (staršia, už vybavená)"); // nedotknutý

  const openAfter = rows.find((r) => r.id === openRow.id);
  expect(openAfter?.resolvedAt).not.toBeNull(); // ZATVORENÝ — nezostal navždy otvorený
  expect(openAfter?.resolvedByUserId).toBeNull(); // "vybavené systémom", nie ručne
  expect(openAfter?.title).toBe("Objednávka 20600200 — vrátený tovar"); // titulok sa NIKDY neupraví, len sa zatvorí
});
