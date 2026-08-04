// issue 226: `runShopFeed` musí uložiť aj `g:availability`, nielen kód/adresu
// — nezávislý zdroj pravdy pre krížovú kontrolu proti nášmu odvodenému stavu.

import { asc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { shopProductUrl } from "../src/db/schema.js";
import { runShopFeed } from "../src/modules/shop-feed/run.js";
import { withCleanDb } from "./helpers/db.js";

const NOW = new Date("2026-08-04T03:50:00Z");

function feedWith(rows: readonly { code: string; availability: string }[]): string {
  const entries = rows
    .map(
      (r) =>
        `<entry><g:id>${r.code}</g:id><link>https://www.forestshop.sk/${r.code}/</link><g:availability>${r.availability}</g:availability></entry>`,
    )
    .join("");
  // MIN_ENTRIES je 1000 — vypĺň zvyšok bezvýznamnými, ale platnými položkami.
  const filler = Array.from(
    { length: 1_000 },
    (_unused, i) => `<entry><g:id>F${String(i)}</g:id><link>https://www.forestshop.sk/f${String(i)}/</link></entry>`,
  ).join("");
  return `<feed>${entries}${filler}</feed>`;
}

describe("runShopFeed — ukladanie dostupnosti (issue 226)", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await withCleanDb());
  });
  afterEach(async () => {
    await close();
  });

  it("uloží g:availability spolu s kódom a adresou", async () => {
    await runShopFeed({
      db,
      now: NOW,
      fetchFeed: () =>
        Promise.resolve(
          feedWith([
            { code: "P1", availability: "in stock" },
            { code: "P2", availability: "out of stock" },
          ]),
        ),
    });

    const rows = await db
      .select({ code: shopProductUrl.code, availability: shopProductUrl.availability })
      .from(shopProductUrl)
      .where(inArray(shopProductUrl.code, ["P1", "P2"]))
      .orderBy(asc(shopProductUrl.code));

    expect(rows).toEqual([
      { code: "P1", availability: "in stock" },
      { code: "P2", availability: "out of stock" },
    ]);
  });

  it("pri opakovanom behu PREPÍŠE staršiu dostupnosť novou (UPSERT)", async () => {
    const runOnce = (availability: string) =>
      runShopFeed({
        db,
        now: NOW,
        fetchFeed: () => Promise.resolve(feedWith([{ code: "Q1", availability }])),
      });

    await runOnce("out of stock");
    await runOnce("in stock");

    const [row] = await db
      .select({ availability: shopProductUrl.availability })
      .from(shopProductUrl)
      .where(eq(shopProductUrl.code, "Q1"));
    expect(row?.availability).toBe("in stock");
  });
});
