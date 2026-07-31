import { afterEach, expect, it } from "vitest";
import { orders } from "../src/db/schema.js";
import { DEFAULT_ORDER_OPEN_STATUS } from "../src/modules/orders/open-statuses.js";
import {
  computeOrderIdsWindowStart,
  findOldestOpenOrderMissingShoptetId,
} from "../src/modules/orders/backfill.js";
import { withCleanDb } from "./helpers/db.js";

// issue 132: majiteľ, dve objednávky (20260739/20260740) nemali interné
// Shoptet id, lebo `createHttpOrderIdsFetcher`'s pevné 90-dňové okno ich už
// dávno nezachytáva (`placedAt` staršie než okno) — hoci Shoptet id MÁ a
// objednávky sú stále otvorené ("Na objednanie"). Tieto testy overujú novú
// `backfill.ts`'s logiku, ktorá okno PRE XML id-fetch (nikdy pre hlavný CSV
// import) sebaozdravujúco predĺži dozadu, kým existuje otvorená objednávka
// bez id.

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

const DEFAULT_DATE_FROM = new Date("2026-05-03T00:00:00Z");

it("findOldestOpenOrderMissingShoptetId vráti null, keď žiadnej otvorenej objednávke id nechýba", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(orders).values({
    externalOrderId: "9101",
    customerName: "Zákazník A",
    statusName: DEFAULT_ORDER_OPEN_STATUS,
    placedAt: new Date("2026-04-01T00:00:00Z"),
    shoptetOrderId: 12345,
  });

  const oldest = await findOldestOpenOrderMissingShoptetId(ctx.db);
  expect(oldest).toBeNull();
});

it("findOldestOpenOrderMissingShoptetId ignoruje UZAVRETÉ objednávky bez id (nie sú v 'Na objednanie')", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(orders).values({
    externalOrderId: "9102",
    customerName: "Zákazník B",
    statusName: "Vybavená", // NIE otvorený stav — mimo listOpenStatusNames()
    placedAt: new Date("2026-01-01T00:00:00Z"),
    shoptetOrderId: null,
  });

  const oldest = await findOldestOpenOrderMissingShoptetId(ctx.db);
  expect(oldest).toBeNull();
});

it("findOldestOpenOrderMissingShoptetId nájde najstaršiu OTVORENÚ objednávku bez id", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(orders).values([
    {
      externalOrderId: "20260739",
      customerName: "Zákazník C",
      statusName: DEFAULT_ORDER_OPEN_STATUS,
      placedAt: new Date("2026-04-30T10:00:00Z"),
      shoptetOrderId: null,
    },
    {
      externalOrderId: "20260740",
      customerName: "Zákazník D",
      statusName: DEFAULT_ORDER_OPEN_STATUS,
      placedAt: new Date("2026-05-01T10:00:00Z"),
      shoptetOrderId: null,
    },
  ]);

  const oldest = await findOldestOpenOrderMissingShoptetId(ctx.db);
  expect(oldest?.toISOString()).toBe(new Date("2026-04-30T10:00:00Z").toISOString());
});

it("computeOrderIdsWindowStart NEZUZUJE predvolené okno, keď nič nechýba", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;

  const windowStart = await computeOrderIdsWindowStart(ctx.db, DEFAULT_DATE_FROM);
  expect(windowStart).toEqual(DEFAULT_DATE_FROM);
});

it("computeOrderIdsWindowStart PREDĹŽI okno dozadu, aby zachytilo staršiu otvorenú objednávku bez id", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const staraObjednavka = new Date("2026-04-30T10:00:00Z"); // staršie než DEFAULT_DATE_FROM
  await ctx.db.insert(orders).values({
    externalOrderId: "20260739",
    customerName: "Zákazník C",
    statusName: DEFAULT_ORDER_OPEN_STATUS,
    placedAt: staraObjednavka,
    shoptetOrderId: null,
  });

  const windowStart = await computeOrderIdsWindowStart(ctx.db, DEFAULT_DATE_FROM);
  expect(windowStart.toISOString()).toBe(staraObjednavka.toISOString());
});

it("computeOrderIdsWindowStart NEROZŠÍRI okno, keď chýbajúca objednávka je UŽ vnútri predvoleného okna", async () => {
  const ctx = await withCleanDb();
  close = ctx.close;
  const novaObjednavka = new Date("2026-06-01T10:00:00Z"); // novšie než DEFAULT_DATE_FROM
  await ctx.db.insert(orders).values({
    externalOrderId: "9103",
    customerName: "Zákazník E",
    statusName: DEFAULT_ORDER_OPEN_STATUS,
    placedAt: novaObjednavka,
    shoptetOrderId: null,
  });

  const windowStart = await computeOrderIdsWindowStart(ctx.db, DEFAULT_DATE_FROM);
  expect(windowStart).toEqual(DEFAULT_DATE_FROM);
});
