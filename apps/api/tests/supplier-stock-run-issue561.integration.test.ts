// Beh dodávateľského skladu — issue 561 (follow-up #552): predfilter
// enumeračných cieľov na NAŠE veľkosti. Enumerácia (#552) sťahovala KAŽDÚ
// veľkosť z dodávateľovho <select>u (wetland: 1440 z 1752 requestov = 82 %,
// nočný beh 122 min nad stropom 2 h). Po predfiltri sa fetchnú len tie ciele,
// ktoré sa párujú na niektorú našu veľkosť — počet enumeračných requestov
// klesne a riadky pre naše veľkosti ostanú IDENTICKÉ (správnosť sa nemení,
// mení sa len náklad sťahovania). Vlastný súbor (eslint max-lines 400).
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

const BASE = fixture("wetland-enum-eagle-bunda-369-2398.html");
const LINK = "https://www.wetland.sk/bundy/deerhunter-eagle-jacket-polovnicka-bunda-369-2398";

// id_attribute (hodnota <option>) → veľkosť → refresh fixtúra (rovnaká mapa
// ako supplier-stock-run-enumeration.integration.test.ts).
const ID_ATTR_TO_SIZE: Readonly<Record<string, number>> = {
  "10": 50,
  "30": 52,
  "31": 54,
  "9": 48,
  "32": 56,
  "33": 58,
  "13": 60,
  "34": 62,
  "35": 64,
};

function wetlandFetcher(onFetch?: (url: string) => void): (url: string) => Promise<PageFetchResult> {
  return (url: string) => {
    onFetch?.(url);
    const ok = (html: string): PageFetchResult => ({ ok: true, html, httpStatus: 200, error: null });
    if (!url.includes("action=refresh")) return Promise.resolve(ok(BASE));
    const idAttr = /group\[1\]=(\d+)/.exec(url)?.[1] ?? "";
    const size = ID_ATTR_TO_SIZE[idAttr];
    if (size === undefined) return Promise.resolve({ ok: false, html: "", httpStatus: 404, error: "neznáma veľkosť" });
    return Promise.resolve(ok(fixture(`wetland-enum-refresh-369-${String(size)}.json`)));
  };
}

const NOW = new Date("2026-09-20T02:20:00.000Z");
const noSleep = (): Promise<void> => Promise.resolve();

describe("beh dodávateľského skladu — issue 561: predfilter enumerácie na naše veľkosti", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await withCleanDb());
  });
  afterEach(async () => {
    await close();
  });

  const rowFor = async (sizeLabel: string): Promise<typeof supplierStock.$inferSelect | undefined> => {
    const [found] = await db
      .select()
      .from(supplierStock)
      .where(and(eq(supplierStock.link, LINK), eq(supplierStock.sizeLabel, sizeLabel)));
    return found;
  };

  it("máme len 48 + 52 (dodávateľ má 9 veľkostí) → fetchnú sa LEN 2 enumeračné GET-y (nie 9), riadky ostanú identické", async () => {
    await insertTestVariantForProduct(db, "eagle369", "eagle369/48", { sizeLabel: "48", internalNote: LINK });
    await insertTestVariantForProduct(db, "eagle369", "eagle369/52", { sizeLabel: "52" });

    const urls: string[] = [];
    const result = await runSupplierStock({
      db,
      now: NOW,
      sleep: noSleep,
      fetchPage: wetlandFetcher((u) => urls.push(u)),
    });

    // Iba naše dve veľkosti sa enumerujú; base GET stále presne jeden.
    const enumUrls = urls.filter((u) => u.includes("action=refresh"));
    expect(enumUrls).toHaveLength(2);
    expect(enumUrls.some((u) => u.includes("group[1]=9"))).toBe(true); // 48
    expect(enumUrls.some((u) => u.includes("group[1]=30"))).toBe(true); // 52
    expect(urls.filter((u) => !u.includes("action=refresh"))).toEqual([LINK]);

    // Riadky pre naše veľkosti IDENTICKÉ ako pri plnej enumerácii (#552).
    expect((await rowFor("48"))?.availability).toBe("unavailable");
    expect((await rowFor("52"))?.availability).toBe("available");
    expect(result.available).toBe(1);
    expect(result.unavailable).toBe(1);

    // hostStats účtuje aj preskočené enumeračné ciele (7 z 9 nemáme).
    const wetland = result.hostStats.find((h) => h.host === "wetland.sk");
    expect(wetland?.requests).toBe(3); // 1 base + 2 enum
    expect(wetland?.enumerationRequests).toBe(2);
    expect(wetland?.enumerationSkipped).toBe(7);
  });

  it("párový štítok '52-60' (dodávateľ má jednotlivé 52 a 60) → OBA ciele sa ponechajú, fold ich zloží", async () => {
    // Keby predfilter jeden z párových tokenov zahodil, `foldMultiTokenSize-
    // Availability` by vrátil `unknown` (neúplný pár) — test to zachytí tým, že
    // 52 (available) + 60 (available) musí zložiť DEFINITÍVNE `available`.
    await insertTestVariantForProduct(db, "eagle369", "eagle369/5260", { sizeLabel: "52-60", internalNote: LINK });

    const urls: string[] = [];
    const result = await runSupplierStock({
      db,
      now: NOW,
      sleep: noSleep,
      fetchPage: wetlandFetcher((u) => urls.push(u)),
    });

    const enumUrls = urls.filter((u) => u.includes("action=refresh"));
    // 52 (id_attr 30) aj 60 (id_attr 13) sa stiahnu — inak by fold vrátil unknown.
    expect(enumUrls.some((u) => u.includes("group[1]=30"))).toBe(true);
    expect(enumUrls.some((u) => u.includes("group[1]=13"))).toBe(true);
    expect(enumUrls).toHaveLength(2);
    expect((await rowFor("52-60"))?.availability).toBe("available");
    expect(result.hostStats.find((h) => h.host === "wetland.sk")?.enumerationSkipped).toBe(7);
  });
});
