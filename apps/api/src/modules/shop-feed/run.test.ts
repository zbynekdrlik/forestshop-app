import { describe, expect, it } from "vitest";
import type { Database } from "../../db/client.js";
import { MIN_ENTRIES } from "./constants.js";
import { runShopFeed } from "./run.js";

// Databáza sa pri tomto scenári NESMIE dotknúť — poistka musí zabrať PRED
// zápisom, inak by pokazený feed mapu adries vyprázdnil. Preto zámerne
// vyhadzujúca atrapa: keby ju beh použil, test padne.
const forbiddenDb = new Proxy(
  {},
  {
    get() {
      throw new Error("beh sa nesmel dotknúť databázy");
    },
  },
) as Database;

function feedWith(count: number): string {
  const entries = Array.from(
    { length: count },
    (_unused, i) =>
      `<entry><g:id>K${String(i)}</g:id><link>https://www.forestshop.sk/p${String(i)}/</link></entry>`,
  ).join("");
  return `<feed>${entries}</feed>`;
}

describe("runShopFeed — poistka proti pokazenému feedu", () => {
  it("pri príliš málo položkách vyhodí a mapu neprepíše", async () => {
    await expect(
      runShopFeed({
        db: forbiddenDb,
        now: new Date("2026-08-04T03:50:00Z"),
        fetchFeed: () => Promise.resolve(feedWith(MIN_ENTRIES - 1)),
      }),
    ).rejects.toThrow(/neprepisuje/);
  });

  it("prázdny feed spadne na tej istej poistke, nie na rozobraní", async () => {
    await expect(
      runShopFeed({
        db: forbiddenDb,
        now: new Date("2026-08-04T03:50:00Z"),
        fetchFeed: () => Promise.resolve(""),
      }),
    ).rejects.toThrow(/len 0 použiteľných/);
  });
});
