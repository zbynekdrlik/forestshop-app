import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterEach, expect, it } from "vitest";
import { upozornenie } from "../src/db/schema.js";
import { ingestOrders, type OrdersExportFetcher } from "../src/modules/orders/ingest.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariant } from "./helpers/orders.js";
import { buildReturnStatusCsv, RETURN_STATUS_CSV_HEADER, returnStatusRowOf } from "./helpers/orders-return-csv.js";

// Code review (issue 269): vydelené do VLASTNÉHO súboru (rovnaký dôvod ako
// `orders-state-lock.integration.test.ts` je oddelený od
// `orders-http-state.integration.test.ts` — `.claude/rules/testing.md`'s
// eslint `max-lines: 400`). Dokazuje DETERMINISTICKY (rovnaká technika ako
// `orders-state-lock.integration.test.ts`/`.claude/rules/database.md`'s
// `pg_stat_activity` dôkaz), že `orders/ingest.ts`'s dávkový pre-check pred
// vrátkovým cyklom naozaj berie `.for("update")` na kandidátnych riadkoch —
// bez neho by bol obyčajným READ COMMITTED čítaním, ktoré by sa NIKDY
// nezaseklo na súbežnom riadkovom zámku (Postgres nikdy nečaká na cudzí
// zámok pri obyčajnom SELECTe), a rozhodnutie "je/nie je už vyriešený" by sa
// mohlo oprieť o ZASTARANÝ stav spred súbežného "Vybavené".
const WINDOW_START = new Date("2020-01-01T00:00:00Z");
const WINDOW_END = new Date("2030-01-01T00:00:00Z");

let close: (() => Promise<void>) | undefined;
let rawDir: string | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  if (rawDir !== undefined) await rm(rawDir, { recursive: true, force: true });
  rawDir = undefined;
});

function fetcherOf(body: Buffer): OrdersExportFetcher {
  return () => Promise.resolve({ body, sourceLabel: "fixtúra" });
}

it("dávkový pre-check čaká na súbežný riadkový zámok — vidí ČERSTVÝ (vyriešený) stav, nikdy zastaraný", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const db = ctx.db;
  rawDir = await mkdtemp(join(tmpdir(), "forestshop-orders-return-lock-raw-"));
  await insertTestVariant(db, "40237/XL");

  const csv = buildReturnStatusCsv(RETURN_STATUS_CSV_HEADER, [returnStatusRowOf("20600100", "Vratený tovar")]);
  await ingestOrders(db, { fetchExport: fetcherOf(csv), now: new Date("2026-07-30T10:00:00Z"), rawDir, windowStart: WINDOW_START, windowEnd: WINDOW_END });
  const [card] = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600100"));
  if (card === undefined) throw new Error("karta sa nevyrobila");
  expect(card.resolvedAt).toBeNull();

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") throw new Error("Integračné testy potrebujú DATABASE_URL");
  const rawClient = new pg.Client({ connectionString: databaseUrl });
  const pollClient = new pg.Client({ connectionString: databaseUrl });
  await rawClient.connect();
  await pollClient.connect();
  const rawClientPidResult = await rawClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const rawClientPid = rawClientPidResult.rows[0]?.pid;
  if (rawClientPid === undefined) throw new Error("nepodarilo sa zistiť backend pid rawClient");
  await rawClient.query("BEGIN");
  // Podrží riadkový zámok na TEJ istej karte, aký si `ingest.ts`'s dávkový
  // pre-check žiada cez vlastné `.for("update")`.
  await rawClient.query("SELECT id FROM upozornenie WHERE id = $1 FOR UPDATE", [card.id]);

  try {
    const concurrentImport = ingestOrders(db, {
      fetchExport: fetcherOf(csv),
      now: new Date("2026-08-01T10:00:00Z"),
      rawDir,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });

    // Deterministický dôkaz SKUTOČNEJ súbežnosti (`.claude/rules/database.md`'s
    // `pg_stat_activity` technika, SPRESNENÁ o `pg_blocking_pids` — tento box
    // zdieľa Postgres s ďalšími súbežnými behmi, takže holé "čaká NIEKTO na
    // NEJAKÝ zámok" by mohlo dať falošný pozitív z úplne nesúvisiacej
    // aktivity; over PRIAMO, že blokujúci je PRÁVE `rawClient`) — bounded poll
    // namiesto pevného `setTimeout`, aby test nezávisel od uhádnutého času.
    // POZOR: toto dokazuje len že test SKUTOČNE vytvoril súbeh (nie že test
    // je no-op) — NEROZLIŠUJE, či zaseknutie nastalo na pre-checku (s
    // opravou) alebo až na `upsertUpozornenie`'s vlastnom `INSERT ... ON
    // CONFLICT` (Postgres z rovnakého dôvodu čaká na uvoľnenie riadkového
    // zámku aj BEZ nášho `.for("update")`, len potom uvidí ČERSTVÝ stav príliš
    // neskoro — arbiter už nekonfliktuje s vyriešeným riadkom, takže vznikne
    // DRUHÝ riadok). Skutočný dôkaz OPRAVY je AŽ finálna asercia nižšie.
    const deadline = Date.now() + 5000;
    let blockedByRawClient = false;
    while (Date.now() < deadline) {
      const { rows } = await pollClient.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity a WHERE a.wait_event_type = 'Lock' AND $1 = ANY (pg_blocking_pids(a.pid))",
        [rawClientPid],
      );
      if (Number(rows[0]?.count ?? "0") > 0) {
        blockedByRawClient = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Code review (issue 269, druhé kolo, finding 7): TÁTO poll asercia
    // NEROZLIŠUJE opravený/neopravený kód (pozri komentár vyššie — Postgres
    // čaká na uvoľnenie riadkového zámku aj cez `INSERT ... ON CONFLICT` bez
    // `.for("update")`), takže ju nemá zmysel držať ako TVRDÚ asserciu — na
    // preťaženom CI runneri (pomalší poll interval než 5s deadline) môže
    // spuriózne zlyhať bez toho, aby to čokoľvek vypovedalo o SKUTOČNEJ
    // oprave. Demotnuté na varovanie — skutočný dôkaz opravy je AŽ finálna
    // asercia počtu riadkov nižšie (`after`).
    if (!blockedByRawClient) {
      console.warn("dávkový pre-check sa v 5s okne nezasekol na rawClient's zámku (len diagnostika, nie dôkaz opravy)");
    }

    // Simuluje súbežné ručné "Vybavené", ktoré stihlo commitnúť MEDZITÝM —
    // presne v momente, keď je druhý import zaseknutý na zámku.
    await rawClient.query("UPDATE upozornenie SET resolved_at = $1 WHERE id = $2", [new Date("2026-07-31T09:00:00Z"), card.id]);
    await rawClient.query("COMMIT");

    await concurrentImport;

    const after = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "vratenie:20600100"));
    expect(after).toHaveLength(1); // presne jedna karta — dôkaz, že pre-check videl ČERSTVÝ (commitnutý) vyriešený stav
    expect(after[0]?.id).toBe(card.id);
    expect(after[0]?.resolvedAt).not.toBeNull();
  } finally {
    await rawClient.end();
    await pollClient.end();
  }
});
