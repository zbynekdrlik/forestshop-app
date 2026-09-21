import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { orderLines, orders } from "../src/db/schema.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariant } from "./helpers/orders.js";

// issue 579 (Štěpán): východiskový stav riadku je NULL (neoznačený) a migrácia
// 0066 zresetuje existujúce `objednane` na NULL. Vydelené z
// `order-schema.integration.test.ts`, aby ani jeden súbor neprerástol eslint
// `max-lines: 400` (`.claude/rules/testing.md`).

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const NOW = new Date("2026-09-21T10:00:00Z");

it("nový riadok objednávky nemá stav (NULL = neoznačený), POST state ho nastaví", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await insertTestVariant(ctx.db, "NULLROW", "Dodávateľ");
  const [order] = await ctx.db
    .insert(orders)
    .values({ externalOrderId: "NULL-1", customerName: "Zákazník", placedAt: NOW })
    .returning();
  if (order === undefined) throw new Error("insert order zlyhal");
  const [line] = await ctx.db
    .insert(orderLines)
    .values({ orderId: order.id, variantCode: "NULLROW", quantity: 1 })
    .returning();
  if (line === undefined) throw new Error("insert riadku zlyhal");

  // Nový riadok: bez stavu (NULL).
  expect(line.state).toBeNull();

  // POST state (cez priamy update, rovnaká cesta ako `setOrderLineState`) nastaví.
  await ctx.db.update(orderLines).set({ state: "skladom" }).where(eq(orderLines.id, line.id));
  const [reread] = await ctx.db.select().from(orderLines).where(eq(orderLines.id, line.id));
  expect(reread?.state).toBe("skladom");
});

it("migrácia 0066: UPDATE zresetuje existujúce 'objednane' na NULL, iné stavy nechá tak", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await insertTestVariant(ctx.db, "RESET-A", "Dod");
  await insertTestVariant(ctx.db, "RESET-B", "Dod");
  await insertTestVariant(ctx.db, "RESET-C", "Dod");
  const [order] = await ctx.db
    .insert(orders)
    .values({ externalOrderId: "RESET-ORD", customerName: "Reset", placedAt: NOW })
    .returning();
  if (order === undefined) throw new Error("insert order zlyhal");
  // Riadok so stavom 'objednane' — reprodukuje PRED-migračný default (nový
  // insert dnes dáva NULL, preto stav nastavíme explicitne).
  const [lineObj] = await ctx.db
    .insert(orderLines)
    .values({ orderId: order.id, variantCode: "RESET-A", quantity: 1, state: "objednane" })
    .returning();
  const [lineCaka] = await ctx.db
    .insert(orderLines)
    .values({ orderId: order.id, variantCode: "RESET-B", quantity: 1, state: "caka_sa" })
    .returning();
  const [lineNull] = await ctx.db
    .insert(orderLines)
    .values({ orderId: order.id, variantCode: "RESET-C", quantity: 1 })
    .returning();
  if (lineObj === undefined || lineCaka === undefined || lineNull === undefined) {
    throw new Error("insert riadkov zlyhal");
  }

  // Prečítaj SKUTOČNÉ UPDATE príkazy z migračného .sql (viazané na jeho obsah,
  // nie re-typovaná kópia — nie tautológia).
  const migrationSql = readFileSync(
    new URL("../drizzle/0066_overconfident_blue_shield.sql", import.meta.url),
    "utf8",
  );
  const updates = migrationSql
    .split("--> statement-breakpoint")
    .map((segment) =>
      segment
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((stmt) => stmt.startsWith("UPDATE"));
  // Presne dva UPDATE-y (order_line + floor_note_product) — poistka, že sa
  // migrácia nezmenila pod testom.
  expect(updates).toHaveLength(2);
  expect(updates.some((u) => u.includes('"order_line"'))).toBe(true);
  expect(updates.some((u) => u.includes('"floor_note_product"'))).toBe(true);
  for (const stmt of updates) {
    await ctx.db.execute(sql.raw(stmt));
  }

  const rows = await ctx.db.select().from(orderLines).where(eq(orderLines.orderId, order.id));
  const byId = new Map(rows.map((r) => [r.id, r.state]));
  expect(byId.get(lineObj.id)).toBeNull(); // 'objednane' → NULL
  expect(byId.get(lineCaka.id)).toBe("caka_sa"); // iný stav ostáva nedotknutý
  expect(byId.get(lineNull.id)).toBeNull(); // NULL ostáva NULL
});
