// Beh dodávateľského skladu — issue 552: enumerácia VŠETKÝCH veľkostí wetland.sk.
// Vydelené zo `supplier-stock-run.integration.test.ts` (eslint max-lines 400).
//
// Prístup 1: po base GET sa z `<select name="group[1]">` poskladajú
// `action=refresh` GET-y per veľkosť (ten istý fetch klient + per-host delay),
// odpovede sa rozbalia a zlúčia — per-veľkosť riadok pre VŠETKY naše veľkosti
// odkazu, `unknown` pre tie, ktoré dodávateľ v selecte nemá. Produkt bez
// veľkostí (bez selectu) → plošný riadok ako fáza 1.
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
const BALLISTOL = fixture("wetland-skladom-ballistol-olej-4478.html");
const BALLISTOL_URL = "https://www.wetland.sk/doplnky/ballistol-universal-oil-035l-olej-na-cistenie-4478";

// id_attribute (hodnota <option>) → veľkosť → refresh fixtúra.
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

/** Fetch klient, ktorý slúži base stránku pre `LINK` a refresh JSON pre každú
 * `action=refresh` URL (podľa `group[1]=<id_attribute>`). */
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

const NOW = new Date("2026-08-03T04:20:00.000Z");
const noSleep = (): Promise<void> => Promise.resolve();

describe("beh dodávateľského skladu — issue 552: enumerácia všetkých veľkostí wetland.sk", () => {
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

  const allRows = async (link: string): Promise<(typeof supplierStock.$inferSelect)[]> =>
    db.select().from(supplierStock).where(eq(supplierStock.link, link));

  it("zapíše per-veľkosť riadok pre VŠETKY naše veľkosti (48/52/60 z dodávateľa) + unknown pre chýbajúcu (99)", async () => {
    await insertTestVariantForProduct(db, "eagle369", "eagle369/48", { sizeLabel: "48", internalNote: LINK });
    await insertTestVariantForProduct(db, "eagle369", "eagle369/52", { sizeLabel: "52" });
    await insertTestVariantForProduct(db, "eagle369", "eagle369/60", { sizeLabel: "60" });
    await insertTestVariantForProduct(db, "eagle369", "eagle369/99", { sizeLabel: "99" });

    const urls: string[] = [];
    const result = await runSupplierStock({
      db,
      now: NOW,
      sleep: noSleep,
      fetchPage: wetlandFetcher((u) => urls.push(u)),
    });

    // Base GET (1) + 9 enumeračných GET-ov.
    expect(urls.filter((u) => u.includes("action=refresh"))).toHaveLength(9);
    expect(urls.filter((u) => !u.includes("action=refresh"))).toEqual([LINK]);

    // Per-veľkosť riadky pre VŠETKY naše veľkosti; žiadny plošný ('') riadok.
    expect((await rowFor("48"))?.availability).toBe("unavailable");
    expect((await rowFor("52"))?.availability).toBe("available");
    expect((await rowFor("60"))?.availability).toBe("available");
    expect((await rowFor("99"))?.availability).toBe("unknown");
    expect(await rowFor("")).toBeUndefined();

    const rows = await allRows(LINK);
    expect(rows.map((r) => r.sizeLabel).sort()).toEqual(["48", "52", "60", "99"]);

    // Určené veľkosti majú confirmed_at, unknown nie (fail-closed čerstvosť).
    expect((await rowFor("52"))?.confirmedAt).not.toBeNull();
    expect((await rowFor("99"))?.confirmedAt).toBeNull();

    // Počty za ZAPÍSANÉ riadky.
    expect(result.available).toBe(2);
    expect(result.unavailable).toBe(1);
    expect(result.unknown).toBe(1);
    expect(result.checked).toBe(1);
  });

  it("job_run.detail nesie počty requestov + čas per host (base + enumerácia)", async () => {
    await insertTestVariantForProduct(db, "eagle369", "eagle369/48", { sizeLabel: "48", internalNote: LINK });
    await insertTestVariantForProduct(db, "eagle369", "eagle369/52", { sizeLabel: "52" });

    const result = await runSupplierStock({ db, now: NOW, sleep: noSleep, fetchPage: wetlandFetcher() });

    const wetland = result.hostStats.find((h) => h.host === "wetland.sk");
    expect(wetland).toBeDefined();
    expect(wetland?.requests).toBe(10); // 1 base + 9 enumeračných
    expect(wetland?.enumerationRequests).toBe(9);
    expect(wetland?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("produkt BEZ veľkostí (olej 4478, žiadny <select>) → plošný riadok, žiadna enumerácia", async () => {
    await insertTestVariantForProduct(db, "olej4478", "olej4478/x", {
      sizeLabel: null,
      internalNote: BALLISTOL_URL,
    });

    const urls: string[] = [];
    const result = await runSupplierStock({
      db,
      now: NOW,
      sleep: noSleep,
      fetchPage: (url) => {
        urls.push(url);
        return Promise.resolve({ ok: true, html: BALLISTOL, httpStatus: 200, error: null });
      },
    });

    // Žiadny enumeračný GET.
    expect(urls.filter((u) => u.includes("action=refresh"))).toHaveLength(0);
    const rows = await allRows(BALLISTOL_URL);
    expect(rows.map((r) => r.sizeLabel)).toEqual([""]);
    expect(rows[0]?.availability).toBe("available");
    expect(result.hostStats.find((h) => h.host === "wetland.sk")?.enumerationRequests).toBe(0);
  });

  it("zlyhaný enumeračný GET jednej veľkosti nezhodí beh — ostatné veľkosti sa aj tak zapíšu", async () => {
    await insertTestVariantForProduct(db, "eagle369", "eagle369/52", { sizeLabel: "52", internalNote: LINK });
    await insertTestVariantForProduct(db, "eagle369", "eagle369/60", { sizeLabel: "60" });

    await runSupplierStock({
      db,
      now: NOW,
      sleep: noSleep,
      fetchPage: (url) => {
        if (url.includes("group[1]=13")) {
          return Promise.resolve({ ok: false, html: "", httpStatus: 500, error: "HTTP 500" });
        }
        return wetlandFetcher()(url);
      },
    });

    // 52 sa prečíta (jeho GET prešiel), 60 (zlyhaný GET) ostáva unknown.
    expect((await rowFor("52"))?.availability).toBe("available");
    expect((await rowFor("60"))?.availability).toBe("unknown");
  });
});
