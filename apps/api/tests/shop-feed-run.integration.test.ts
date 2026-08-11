// issue 226: `runShopFeed` musí uložiť aj `g:availability`, nielen kód/adresu
// — nezávislý zdroj pravdy pre krížovú kontrolu proti nášmu odvodenému stavu.

import { asc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { shopProductUrl } from "../src/db/schema.js";
import { runShopFeed } from "../src/modules/shop-feed/run.js";
import { withCleanDb } from "./helpers/db.js";

const NOW = new Date("2026-08-04T03:50:00Z");

function feedWith(rows: readonly { code: string; availability: string | null }[]): string {
  const entries = rows
    .map(
      (r) =>
        // `null` = <g:availability> značka CELKOM chýba (nie len prázdna) —
        // presne ten tvar, ktorým Shoptet feed vie prestať dostupnosť niesť.
        `<entry><g:id>${r.code}</g:id><link>https://www.forestshop.sk/${r.code}/</link>${
          r.availability === null ? "" : `<g:availability>${r.availability}</g:availability>`
        }</entry>`,
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

  // Code review issue 226: `run.ts`'s komentár tvrdí, že explicitný
  // `set: { availability: sql\`excluded.availability\` }` existuje PRÁVE
  // preto, aby sa stará hodnota prepísala na `null`, keď feed značku
  // stratí — dovtedy to netestoval žiadny test.
  it("keď feed <g:availability> značku STRATÍ, uložená hodnota sa prepíše na null (nezostane stará)", async () => {
    const runOnce = (availability: string | null) =>
      runShopFeed({
        db,
        now: NOW,
        fetchFeed: () => Promise.resolve(feedWith([{ code: "R1", availability }])),
      });

    await runOnce("in stock");
    await runOnce(null);

    const [row] = await db
      .select({ availability: shopProductUrl.availability })
      .from(shopProductUrl)
      .where(eq(shopProductUrl.code, "R1"));
    expect(row?.availability).toBeNull();
  });
});

// issue 347: `runShopFeed` musí uložiť aj `g:image_link` — appka ho potrebuje
// na vykreslenie produktovej karty v e-maile "alternatívy k nedostupnému
// tovaru" (`nedostupne/resolve-products.ts`).
describe("runShopFeed — ukladanie obrázka produktu (issue 347)", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await withCleanDb());
  });
  afterEach(async () => {
    await close();
  });

  function feedWithImage(rows: readonly { code: string; imageUrl: string | null }[]): string {
    const entries = rows
      .map(
        (r) =>
          `<entry><g:id>${r.code}</g:id><link>https://www.forestshop.sk/${r.code}/</link>${
            r.imageUrl === null ? "" : `<g:image_link>${r.imageUrl}</g:image_link>`
          }</entry>`,
      )
      .join("");
    const filler = Array.from(
      { length: 1_000 },
      (_unused, i) => `<entry><g:id>IMG${String(i)}</g:id><link>https://www.forestshop.sk/img${String(i)}/</link></entry>`,
    ).join("");
    return `<feed>${entries}${filler}</feed>`;
  }

  it("uloží g:image_link spolu s kódom a adresou", async () => {
    await runShopFeed({
      db,
      now: NOW,
      fetchFeed: () =>
        Promise.resolve(
          feedWithImage([{ code: "I1", imageUrl: "https://cdn.example.sk/i1.jpg" }, { code: "I2", imageUrl: null }]),
        ),
    });

    const rows = await db
      .select({ code: shopProductUrl.code, imageUrl: shopProductUrl.imageUrl })
      .from(shopProductUrl)
      .where(inArray(shopProductUrl.code, ["I1", "I2"]))
      .orderBy(asc(shopProductUrl.code));

    expect(rows).toEqual([
      { code: "I1", imageUrl: "https://cdn.example.sk/i1.jpg" },
      { code: "I2", imageUrl: null },
    ]);
  });

  it("pri opakovanom behu PREPÍŠE starší obrázok novým (UPSERT), aj keď feed značku STRATÍ (prepíše na null)", async () => {
    const runOnce = (imageUrl: string | null) =>
      runShopFeed({ db, now: NOW, fetchFeed: () => Promise.resolve(feedWithImage([{ code: "J1", imageUrl }])) });

    await runOnce("https://cdn.example.sk/stary.jpg");
    await runOnce("https://cdn.example.sk/novy.jpg");
    let [row] = await db.select({ imageUrl: shopProductUrl.imageUrl }).from(shopProductUrl).where(eq(shopProductUrl.code, "J1"));
    expect(row?.imageUrl).toBe("https://cdn.example.sk/novy.jpg");

    await runOnce(null);
    [row] = await db.select({ imageUrl: shopProductUrl.imageUrl }).from(shopProductUrl).where(eq(shopProductUrl.code, "J1"));
    expect(row?.imageUrl).toBeNull();
  });
});
