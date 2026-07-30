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

    let doriesene = false;
    void bulk.then(() => {
      doriesene = true;
    });

    // Dá bulk lookupu dosť času dôjsť k zámku a zaseknúť sa naň — zámok drží
    // `rawClient`, takže "príliš neskoro" tu nehrozí, len čakáme, kým sa naň
    // naozaj zasekne.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(doriesene).toBe(false);

    // Simuluje súbežnú zmenu, ktorá stihla commitnúť MEDZITÝM — priamo, mimo
    // `setSupplierLinesOrdered`, presne v momente, keď je bulk akcia
    // zaseknutá na zámku.
    await rawClient.query("COMMIT");

    const result = await bulk;
    expect(result).toEqual({ lineCount: 1 });
    expect(doriesene).toBe(true);
  } finally {
    await rawClient.end();
  }
});
