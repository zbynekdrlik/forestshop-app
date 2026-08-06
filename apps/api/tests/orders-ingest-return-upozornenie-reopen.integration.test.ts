import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { upozornenie, users } from "../src/db/schema.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { ingestOrders, type OrdersExportFetcher } from "../src/modules/orders/ingest.js";
import { resolveUpozornenie, returnUpozornenieToOpen } from "../src/modules/upozornenia/service.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariant } from "./helpers/orders.js";
import { encodeCp1250, RETURN_STATUS_CSV_HEADER, buildReturnStatusCsv, returnStatusRowOf } from "./helpers/orders-return-csv.js";

// issue 283 (majiteľova podmienka na tickete): keď sa vybavené vrátenie
// vráti späť medzi otvorené (`returnUpozornenieToOpen`), `orders/ingest.ts`'s
// pre-check (`hasUnresolvedByKey`) uvidí pre jej `dedupKey` NEVYRIEŠENÝ
// súrodenec — ĎALŠÍ nočný import ju preto ZNOVA obnoví (rovnaká cesta, akou
// by prešla akákoľvek iná otvorená vrátková karta). Ticket to explicitne
// hovorí ako OČAKÁVANÉ/SPRÁVNE správanie ("that is correct and intended") —
// tento test to DOKAZUJE, kód `ingest.ts` sa NEMENÍ. Vydelené do VLASTNÉHO
// súboru rovnakým vzorom ako `-lock.integration.test.ts` (`.claude/rules/
// testing.md`'s eslint `max-lines: 400`, existujúci `orders-ingest-return-
// upozornenie.integration.test.ts` je už na 309 riadkoch).
const WINDOW_START = new Date("2020-01-01T00:00:00Z");
const WINDOW_END = new Date("2030-01-01T00:00:00Z");
const NOW = new Date("2026-08-06T10:00:00Z");

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
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-orders-return-reopen-raw-"));
  return { db: ctx.db, dir: rawDir };
}

function fetcherOf(body: Buffer): OrdersExportFetcher {
  return () => Promise.resolve({ body, sourceLabel: "fixtúra" });
}

it("encodeCp1250 je verný inverzný krok voči appkinmu decodeCp1250 (sebakontrola fixtúry)", () => {
  expect(new TextDecoder("windows-1250").decode(encodeCp1250("Vratený tovar"))).toBe("Vratený tovar");
});

it("karta vrátená späť medzi otvorené sa ĎALŠÍM importom ZNOVA obnoví — nezostane navždy zamrznutá", async () => {
  const { db, dir } = await boot();
  await insertTestVariant(db, "40237/XL");
  const csv = buildReturnStatusCsv(RETURN_STATUS_CSV_HEADER, [returnStatusRowOf("20700010", "Vratený tovar")]);

  await ingestOrders(db, { fetchExport: fetcherOf(csv), now: NOW, rawDir: dir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const before = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20700010"));
  expect(before).toHaveLength(1);
  const cardId = before[0]?.id;
  if (cardId === undefined) throw new Error("karta sa nevyrobila");

  const [user] = await db
    .insert(users)
    .values({ email: "majitel-283-reopen@forestshop.sk", passwordHash: await hashPassword("test-heslo-abc"), displayName: "Majiteľ", role: "manazer" })
    .returning({ id: users.id });
  if (user === undefined) throw new Error("test používateľ sa nepodarilo vložiť");

  // Majiteľ omylom klikol "Vybavené", potom si to rozmyslel a vrátil kartu
  // späť medzi otvorené zo záložky "Vybavené".
  expect(await resolveUpozornenie(db, { id: cardId, resolvedByUserId: user.id, now: new Date("2026-08-06T11:00:00Z") })).toBe(true);
  expect(await returnUpozornenieToOpen(db, { id: cardId })).toBe("returned");
  const afterReturn = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20700010"));
  expect(afterReturn).toHaveLength(1); // stále JEDNA karta — vrátenie neduplikuje
  expect(afterReturn[0]?.resolvedAt).toBeNull();

  // Ďalší import (napr. nasledujúcu noc) — karta je teraz NEVYRIEŠENÁ, takže
  // pre-check ju NEPRESKOČÍ; ten istý pod-stav sa upsertne (obnoví) ako
  // ktorákoľvek iná otvorená vrátková karta.
  await ingestOrders(db, {
    fetchExport: fetcherOf(buildReturnStatusCsv(RETURN_STATUS_CSV_HEADER, [returnStatusRowOf("20700010", "Vybavená výmena")])),
    now: new Date("2026-08-07T10:00:00Z"),
    rawDir: dir,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });

  const after = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20700010"));
  expect(after).toHaveLength(1); // stále presne jedna karta, žiadna duplicita
  expect(after[0]?.id).toBe(cardId); // TÁ ISTÁ karta — obnovená, nie nová
  expect(after[0]?.resolvedAt).toBeNull(); // ostáva otvorená
  expect(after[0]?.title).toContain("vybavená výmena"); // OBNOVENÁ — dôkaz že import ju vôbec nepreskočil
});
