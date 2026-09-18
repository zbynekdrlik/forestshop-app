// Vydelené zo `supplier-stock-run.integration.test.ts`, aby ani jeden súbor
// nenarástol cez eslint `max-lines: 400` (`.claude/rules/testing.md`).
//
// issue 551 (dodatok): plošný riadok (`size_label=''`) na doméne s per-veľkosť
// pravidlom, pre ktorú MÁME naše veľkosti, mohla zapísať len STARŠIA verzia
// pravidla (pred #551) — nesmie sa brať ako čerstvý, inak by ho nočný beh
// preskočil a `restock` blanket-párovanie by prepínalo cudzie veľkosti až do
// vypršania `MAX_AGE_HOURS`. Reprodukcia PROD stavu z 18. 9.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { supplierStock } from "../src/db/schema.js";
import type { PageFetchResult } from "../src/modules/supplier-stock/page-fetcher.js";
import { runSupplierStock } from "../src/modules/supplier-stock/run.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariantForProduct } from "./helpers/orders.js";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../src/modules/supplier-stock/fixtures/${name}`, import.meta.url)),
    "utf8",
  );
}

const WETLAND_ERIC = fixture("wetland-skladom-eric-kosela-542-8845.html");
const WETLAND_ERIC_URL = "https://www.wetland.sk/kosele/deerhunter-eric-shirt-polovnicka-kosela-542-8845";

const okPage = (html: string): PageFetchResult => ({ ok: true, html, httpStatus: 200, error: null });
const IN_STOCK = `<script type="application/ld+json">
  {"@type":"Product","offers":{"@type":"Offer","availability":"https://schema.org/InStock","price":"12,50"}}
</script>`;

const NOW = new Date("2026-08-03T04:20:00.000Z");
const noSleep = (): Promise<void> => Promise.resolve();

describe("beh dodávateľského skladu — issue 551 dodatok: plošný riadok na size-rule doméne nie je čerstvý", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await withCleanDb());
  });
  afterEach(async () => {
    await close();
  });

  const rowFor = async (
    link: string,
    sizeLabel: string,
  ): Promise<typeof supplierStock.$inferSelect | undefined> => {
    const [found] = await db
      .select()
      .from(supplierStock)
      .where(and(eq(supplierStock.link, link), eq(supplierStock.sizeLabel, sizeLabel)));
    return found;
  };

  const allRowsFor = async (link: string): Promise<(typeof supplierStock.$inferSelect)[]> =>
    db.select().from(supplierStock).where(eq(supplierStock.link, link));

  const insertBlanket = async (link: string, host: string, confirmedAt: Date): Promise<void> => {
    await db.insert(supplierStock).values({
      link,
      sizeLabel: "",
      host,
      availability: "available",
      availabilityText: "",
      price: null,
      source: "text",
      ok: true,
      error: null,
      httpStatus: 200,
      checkedAt: confirmedAt,
      confirmedAt,
    });
  };

  const oHodinuPredtym = new Date(NOW.getTime() - 3_600_000);

  it("(a) čerstvý plošný riadok na wetland.sk s našimi veľkosťami sa NEPRESKOČÍ — prepíše sa per-veľkosť", async () => {
    await insertTestVariantForProduct(db, "ericfresh", "ericfresh/39-40", {
      sizeLabel: "39/40",
      internalNote: WETLAND_ERIC_URL,
    });
    await insertTestVariantForProduct(db, "ericfresh", "ericfresh/41-42", { sizeLabel: "41/42" });
    await insertBlanket(WETLAND_ERIC_URL, "wetland.sk", oHodinuPredtym);

    let volani = 0;
    const result = await runSupplierStock({
      db,
      now: NOW,
      sleep: noSleep,
      fetchPage: () => {
        volani += 1;
        return Promise.resolve(okPage(WETLAND_ERIC));
      },
    });

    // Plošný riadok NIE JE čerstvý → linka sa stiahne znovu.
    expect(volani).toBe(1);
    expect(result.checked).toBe(1);
    expect(result.skipped).toBe(0);

    // Plošný riadok zmizne, nahradia ho per-veľkosť riadky.
    expect(await rowFor(WETLAND_ERIC_URL, "")).toBeUndefined();
    expect((await rowFor(WETLAND_ERIC_URL, "39/40"))?.availability).toBe("available");
    expect((await rowFor(WETLAND_ERIC_URL, "41/42"))?.availability).toBe("unknown");
    const all = await allRowsFor(WETLAND_ERIC_URL);
    expect(all.map((r) => r.sizeLabel).sort()).toEqual(["39/40", "41/42"]);
  });

  it("(b) čerstvý plošný riadok na wetland.sk BEZ našich veľkostí sa preskočí (blanket cesta zachovaná)", async () => {
    await insertTestVariantForProduct(db, "ericnosize", "ericnosize/x", {
      sizeLabel: null,
      internalNote: WETLAND_ERIC_URL,
    });
    await insertBlanket(WETLAND_ERIC_URL, "wetland.sk", oHodinuPredtym);

    let volani = 0;
    const result = await runSupplierStock({
      db,
      now: NOW,
      sleep: noSleep,
      fetchPage: () => {
        volani += 1;
        return Promise.resolve(okPage(WETLAND_ERIC));
      },
    });

    expect(volani).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.checked).toBe(0);
    // Plošný riadok ostáva nedotknutý.
    const all = await allRowsFor(WETLAND_ERIC_URL);
    expect(all.map((r) => r.sizeLabel)).toEqual([""]);
  });

  it("(c) čerstvý plošný riadok na doméne BEZ per-veľkosť pravidla (odimon.sk) sa preskočí", async () => {
    const ODIMON_URL = "https://odimon.sk/nejaky-produkt";
    await insertTestVariantForProduct(db, "odimonprod", "odimonprod/m", {
      sizeLabel: "M",
      internalNote: ODIMON_URL,
    });
    await insertBlanket(ODIMON_URL, "odimon.sk", oHodinuPredtym);

    let volani = 0;
    const result = await runSupplierStock({
      db,
      now: NOW,
      sleep: noSleep,
      fetchPage: () => {
        volani += 1;
        return Promise.resolve(okPage(IN_STOCK));
      },
    });

    expect(volani).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.checked).toBe(0);
  });
});
