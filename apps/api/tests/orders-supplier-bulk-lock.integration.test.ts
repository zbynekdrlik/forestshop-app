import pg from "pg";
import { afterEach, expect, it } from "vitest";
import { orderLines, orderOpenStatuses, orders, users } from "../src/db/schema.js";
import { setSupplierLinesOrdered } from "../src/modules/orders/state.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// Code review finding on review of PR 75 (issue 60, finding 3):
// `listOpenOrderLineIdsForSupplier` was originally read OUTSIDE the
// transaction that later performs the bulk UPDATE — between the read and
// the write, a concurrent order re-import or per-row toggle could change
// which lines count as "open" for that supplier (no data corruption, each
// write is by explicit id, but a real narrow TOCTOU window). Fix: the id
// lookup now runs INSIDE the same transaction as the write, `.for("update")`
// on the joined `order_line`/`order`/`variant`/`product` query.
//
// Same deterministic proof technique as `orders-state-lock.integration.test.ts`:
// hold `SELECT ... FOR UPDATE` on the `order` row (part of the lookup's
// JOIN) open in an uncommitted transaction from a second raw connection.
// `FOR UPDATE` with no `OF` list locks rows in EVERY table referenced by the
// query (Postgres docs) — so once the lookup runs `.for("update")` across
// the join, it must lock the matched `order` row too, and therefore block on
// this held lock. BEFORE the fix, the lookup was a plain unlocked SELECT
// outside any transaction — a plain read never waits on another
// transaction's row lock in Postgres MVCC, so the bulk call would race
// ahead completely unaffected by the held lock. This is what makes the test
// fail on the unfixed code (the call resolves well before the raw
// connection commits) and pass on the fixed code (the call blocks until the
// commit).

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

// Code review (review of PR 76, finding 2 + finding 4): the first version of
// this "is it still blocked?" check slept a fixed 200ms and then read a flag
// set by an unhandled-rejection-prone `.then()`. On a loaded CI runner the
// PRE-FIX (unlocked) path could easily take longer than 200ms too, so the
// sleep could pass against unfixed code (false green) — and a rejected
// `bulk` promise (e.g. a lock-timeout or deadlock abort) would surface as an
// unhandled rejection Vitest could blame on an unrelated later test in this
// single-process run. This poll instead asks Postgres DIRECTLY whether some
// OTHER backend is genuinely blocked on a row lock — deterministic, and
// completely decoupled from how fast the JS event loop schedules
// microtasks. `withCleanDb()`'s advisory isolation lock + this project's
// `fileParallelism: false` (`.claude/rules/testing.md`) guarantee no other
// CLIENT backend is active during this test, so any lock-blocked client
// backend found here can only be the bulk call under test — `backend_type =
// 'client backend'` (deep-review suggestion, review of PR 76) narrows this
// further, excluding autovacuum/background-writer/checkpointer backends
// that could theoretically also show `wait_event_type = 'Lock'` briefly.
async function waitUntilSomeBackendIsLockBlocked(rawClient: pg.Client, deadlineMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const { rows } = await rawClient.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity" +
        " WHERE wait_event_type = 'Lock' AND backend_type = 'client backend' AND pid <> pg_backend_pid()",
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() - start > deadlineMs) {
      throw new Error(
        "Bulk volanie sa v " + String(deadlineMs) + "ms nikdy nezaseklo na zámku (pg_stat_activity nič neukázal)",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

it("hromadné označenie čaká na riadkový zámok objednávky — lookup beží VNÚTRI transakcie s FOR UPDATE", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const db = ctx.db;

  await db.insert(orderOpenStatuses).values({ statusName: "Vybavuje sa" }).onConflictDoNothing();
  await insertTestVariant(db, "L-1", "Dodávateľ Lock");
  const [pouzivatel] = await db
    .insert(users)
    .values({
      email: "manazer-bulk-lock-test@forestshop.sk",
      passwordHash: "x", // FK potrebuje existujúci riadok, heslo sa v tomto teste nikdy neoveruje
      displayName: "Manažér",
      role: "manazer",
    })
    .returning({ id: users.id });
  if (pouzivatel === undefined) throw new Error("insert používateľa zlyhal");

  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "6001", customerName: "Zákazník", placedAt: new Date("2026-07-20T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert objednávky zlyhal");
  const [riadok] = await db
    .insert(orderLines)
    .values({ orderId: objednavka.id, variantCode: "L-1", quantity: 1 })
    .returning();
  if (riadok === undefined) throw new Error("insert riadku zlyhal");

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("Integračné testy potrebujú DATABASE_URL");
  }
  const rawClient = new pg.Client({ connectionString: databaseUrl });
  await rawClient.connect();
  await rawClient.query("BEGIN");
  // Podrží riadkový zámok na `order` riadku — súčasti JOINu, ktorý
  // `listOpenOrderLineIdsForSupplier` používa.
  await rawClient.query('SELECT id FROM "order" WHERE id = $1 FOR UPDATE', [objednavka.id]);

  try {
    const bulk = setSupplierLinesOrdered(db, {
      supplier: "Dodávateľ Lock",
      ordered: true,
      actorUserId: pouzivatel.id,
      now: new Date("2026-07-30T10:00:00Z"),
    });

    // Code review (review of PR 76, finding 4): `.then(onFulfilled)` bez
    // druhého argumentu necháva `bulk`-ov prípadný reject (napr. lock
    // timeout/deadlock) bez ošetrenia — Node by taký unhandled rejection
    // mohol pripísať úplne inému, neskoršiemu testu v tomto
    // jednoprocesovom behu (`fileParallelism: false`). Druhý argument
    // (no-op) ošetrenie pridáva bez toho, aby menil `settled`'s zámer.
    let settled = false;
    bulk.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // Code review (review of PR 76, finding 2): namiesto pevného 200ms
    // spánku (na preťaženom CI runneri mohla aj PRE-FIX odomknutá cesta
    // trvať dlhšie, čo by test nechalo prejsť aj proti nefixnutému kódu)
    // sa čaká DETERMINISTICKY, kým Postgres sám nepotvrdí, že bulk volanie
    // je zaseknuté na zámku (`pg_stat_activity.wait_event_type = 'Lock'`).
    await waitUntilSomeBackendIsLockBlocked(rawClient);
    expect(settled).toBe(false);

    // Simuluje súbežnú zmenu, ktorá stihla commitnúť MEDZITÝM — priamo, mimo
    // `setSupplierLinesOrdered`, presne v momente, keď je bulk akcia
    // zaseknutá na zámku.
    await rawClient.query("COMMIT");

    // Code review (review of PR 76, finding 3): `expect(settled).toBe(true)`
    // TU by bolo tautologické — `.then()` zaregistrovaný vyššie sa
    // vyhodnotí ako mikroúloha PRED pokračovaním tohto `await`u, takže by
    // bol vždy `true` bez ohľadu na to, či testovaný kód skutočne funguje.
    // Skutočný dôkaz dokončenia je samotný úspešný `await bulk` +
    // očakávaný výsledok nižšie — žiadna ďalšia kontrola `settled` netreba.
    const result = await bulk;
    expect(result).toEqual({ lineCount: 1 });
  } finally {
    await rawClient.end();
  }
});

// Code review (review of PR 76, finding 1): `.for("update")` bez `of`
// zoznamu zamyká VŠETKY štyri JOINnuté tabuľky (`order_line`, `order`,
// `variant`, `product`) — aj tie dve KATALÓGOVÉ, ktoré tento zápis vôbec
// nemutuje. `catalog/ingest.ts` berie svoj dlhý import v poradí produkt →
// variant (upsert produktov, potom variantov, plus záverečný hromadný
// `UPDATE variant`), zatiaľ čo LockRows uzol tohto dopytu by zamykal v
// poradí rozsahovej tabuľky (order_line → order → variant → product) —
// OPAČNÉ poradie zámkov medzi dvomi transakciami je klasický predpoklad na
// deadlock (a v najlepšom prípade aspoň zbytočné čakanie hromadnej akcie na
// celý beh importu). Fix zužuje zámok na `of: [orderLines, orders]` —
// zachováva ten istý TOCTOU uzáver (test vyššie), ale prestáva zamykať
// `variant`/`product` riadky.
it("hromadné označenie NEČAKÁ na zámok katalógovej tabuľky (product) — .for(\"update\") je zúžený na order_line + order", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const db = ctx.db;

  await db.insert(orderOpenStatuses).values({ statusName: "Vybavuje sa" }).onConflictDoNothing();
  await insertTestVariant(db, "L-2", "Dodávateľ Lock2");
  const [pouzivatel] = await db
    .insert(users)
    .values({
      email: "manazer-bulk-lock-scope-test@forestshop.sk",
      passwordHash: "x",
      displayName: "Manažér",
      role: "manazer",
    })
    .returning({ id: users.id });
  if (pouzivatel === undefined) throw new Error("insert používateľa zlyhal");

  const [objednavka] = await db
    .insert(orders)
    .values({ externalOrderId: "6002", customerName: "Zákazník", placedAt: new Date("2026-07-20T00:00:00Z") })
    .returning();
  if (objednavka === undefined) throw new Error("insert objednávky zlyhal");
  const [riadok] = await db
    .insert(orderLines)
    .values({ orderId: objednavka.id, variantCode: "L-2", quantity: 1 })
    .returning();
  if (riadok === undefined) throw new Error("insert riadku zlyhal");

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("Integračné testy potrebujú DATABASE_URL");
  }
  const rawClient = new pg.Client({ connectionString: databaseUrl });
  await rawClient.connect();
  await rawClient.query("BEGIN");
  // Zamkne PRODUKTOVÝ riadok — súčasť toho istého JOINu, ale nie tabuľku,
  // ktorú tento zápis mutuje. Zámok sa NEUVOĽNÍ (COMMIT ide až v `finally`,
  // PO `await` na bulk volanie nižšie) — na nezúženom `.for("update")` (bez
  // `of`) by preto `await setSupplierLinesOrdered(...)` NIKDY nedokončil a
  // test by spoľahlivo padol na `testTimeout` (30s, `vitest.config.ts`).
  await rawClient.query('SELECT key FROM "product" WHERE key = $1 FOR UPDATE', ["L-2"]);

  try {
    const result = await setSupplierLinesOrdered(db, {
      supplier: "Dodávateľ Lock2",
      ordered: true,
      actorUserId: pouzivatel.id,
      now: new Date("2026-07-30T10:00:00Z"),
    });

    expect(result).toEqual({ lineCount: 1 });
  } finally {
    await rawClient.query("COMMIT");
    await rawClient.end();
  }
});
