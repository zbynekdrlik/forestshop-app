// issue 585: huntingshop.eu per-veľkosť pravidlo — celá cesta nočný
// supplier-stock beh (fake fetcher, živé fixtúry) → `supplier_stock` riadky →
// výber kandidátov restocku. Reprodukuje PROD stav z 2. 10. 2026: čerstvý PLOŠNÝ
// riadok huntingshop odkazu („skladom" za celý produkt) prepínal aj veľkosti,
// ktoré dodávateľ nemá (62780/43, 62780/44 Tracker BOA GTX).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { productSupplierLinkOverrides, supplierStock, variants } from "../src/db/schema.js";
import { selectRestockCandidates } from "../src/modules/restock/queries.js";
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

const PAGES: Readonly<Record<string, string>> = {
  "https://www.huntingshop.eu/tracker-boa-gtx-obuv-military-green-8954": fixture("huntingshop-velkosti-tracker-boa-8954.html"),
  "https://www.huntingshop.eu/shade-h-hoodie-mikina-pixel-forest-14093": fixture("huntingshop-velkosti-shade-h-mikina-14093.html"),
  "https://www.huntingshop.eu/olej-na-zbrane-beretta-125-ml-4796": fixture("huntingshop-jednovelkostny-olej-4796.html"),
};
const TRACKER = "https://www.huntingshop.eu/tracker-boa-gtx-obuv-military-green-8954";
const SHADE = "https://www.huntingshop.eu/shade-h-hoodie-mikina-pixel-forest-14093";
const OLEJ = "https://www.huntingshop.eu/olej-na-zbrane-beretta-125-ml-4796";

const NOW = new Date("2026-10-02T02:20:00.000Z");
const noSleep = (): Promise<void> => Promise.resolve();
const fetchPage = (url: string): Promise<PageFetchResult> => {
  const html = PAGES[url];
  return Promise.resolve(
    html === undefined
      ? { ok: false, html: "", httpStatus: 404, error: `neznáma adresa ${url}` }
      : { ok: true, html, httpStatus: 200, error: null },
  );
};

describe("beh dodávateľského skladu — issue 585: huntingshop.eu per-veľkosť", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await withCleanDb());
  });
  afterEach(async () => {
    await close();
  });

  const seedOutOfStock = async (productKey: string, code: string, sizeLabel: string | null, link: string): Promise<void> => {
    await insertTestVariantForProduct(db, productKey, code, { sizeLabel, internalNote: link });
    await db
      .update(variants)
      .set({ state: "out_of_stock", stock: 0, availabilityText: "Vypredané" })
      .where(eq(variants.code, code));
  };

  const availabilityOf = async (link: string, sizeLabel: string): Promise<string | undefined> => {
    const [row] = await db
      .select({ availability: supplierStock.availability })
      .from(supplierStock)
      .where(and(eq(supplierStock.link, link), eq(supplierStock.sizeLabel, sizeLabel)));
    return row?.availability;
  };

  it("zapíše per-veľkosť riadky a restock vyberie LEN veľkosti z výberu Kúpiť", async () => {
    for (const size of ["42", "43", "44", "45"]) await seedOutOfStock("62780", `62780/${size}`, size, TRACKER);
    for (const size of ["M", "L"]) await seedOutOfStock("62794", `62794/${size}`, size, SHADE);
    await seedOutOfStock("olej4796", "olej4796", null, OLEJ);
    // PROD stav pred opravou: čerstvý plošný riadok „skladom" za celý odkaz.
    await db.insert(supplierStock).values({
      link: TRACKER,
      sizeLabel: "",
      host: "huntingshop.eu",
      availability: "available",
      availabilityText: "Skladom viac ako 3 kusy",
      price: null,
      source: "text",
      ok: true,
      error: null,
      httpStatus: 200,
      checkedAt: new Date(NOW.getTime() - 3_600_000),
      confirmedAt: new Date(NOW.getTime() - 3_600_000),
    });

    const result = await runSupplierStock({ db, now: NOW, sleep: noSleep, fetchPage });
    expect(result.checked).toBe(3);
    expect(result.skipped).toBe(0);

    // Plošný riadok nahradený per-veľkosť riadkami.
    expect(await availabilityOf(TRACKER, "")).toBeUndefined();
    expect(await availabilityOf(TRACKER, "43")).toBe("unavailable");
    expect(await availabilityOf(TRACKER, "44")).toBe("unavailable");
    expect(await availabilityOf(TRACKER, "42")).toBe("available");
    expect(await availabilityOf(TRACKER, "45")).toBe("available");
    expect(await availabilityOf(SHADE, "L")).toBe("unavailable");
    expect(await availabilityOf(SHADE, "M")).toBe("available");
    // Jednoveľkostný produkt: plošný riadok ako doteraz.
    expect(await availabilityOf(OLEJ, "")).toBe("available");

    const { picked } = await selectRestockCandidates(db, NOW);
    expect(picked.map((c) => c.variantCode).sort()).toEqual(["62780/42", "62780/45", "62794/M", "olej4796"]);
  });

  it("zmenená štruktúra stránky (výber Kúpiť chýba, Strážny pes áno) → chybový riadok ok=false, nikdy available", async () => {
    for (const size of ["42", "43"]) await seedOutOfStock("62780", `62780/${size}`, size, TRACKER);
    const changed = (PAGES[TRACKER] ?? "").replace('id="frm-addToCart-form-variant_id"', 'id="frm-addToCart-form-variant"');
    expect(changed).not.toBe(PAGES[TRACKER]);

    const result = await runSupplierStock({
      db,
      now: NOW,
      sleep: noSleep,
      fetchPage: () => Promise.resolve({ ok: true, html: changed, httpStatus: 200, error: null }),
    });
    expect(result.failed).toBe(1);
    expect(result.available).toBe(0);

    const rows = await db.select().from(supplierStock).where(eq(supplierStock.link, TRACKER));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.availability).toBe("unknown");
    expect(rows[0]?.error).toMatch(/bez výberu veľkosti/);
    expect((await selectRestockCandidates(db, NOW)).picked).toHaveLength(0);
  });

  // Code review issue 585: odkaz z Párovania/Vyhľadať (`product_supplier_link_override`)
  // je pre zber aj restock EFEKTÍVNY odkaz — naše veľkosti sa preň musia zbierať
  // rovnako, inak `ourSizes=[]` → plošný riadok zo štítku pri cene → restock
  // prepne aj 43/44. Na PROD má takýto odkaz 4 huntingshop produkty (2. 10. 2026).
  it("odkaz LEN z product_supplier_link_override (poznámka bez URL) → per-veľkosť, 43/44 sa neprepnú", async () => {
    for (const size of ["42", "43", "44"]) {
      await insertTestVariantForProduct(db, "62780ovr", `62780ovr/${size}`, { sizeLabel: size, internalNote: "betalov" });
      await db
        .update(variants)
        .set({ state: "out_of_stock", stock: 0, availabilityText: "Vypredané" })
        .where(eq(variants.code, `62780ovr/${size}`));
    }
    await db.insert(productSupplierLinkOverrides).values({ productKey: "62780ovr", url: TRACKER, updatedAt: NOW });

    const result = await runSupplierStock({ db, now: NOW, sleep: noSleep, fetchPage });
    expect(result.checked).toBe(1);

    expect(await availabilityOf(TRACKER, "")).toBeUndefined();
    expect(await availabilityOf(TRACKER, "43")).toBe("unavailable");
    expect(await availabilityOf(TRACKER, "44")).toBe("unavailable");
    expect(await availabilityOf(TRACKER, "42")).toBe("available");
    const { picked } = await selectRestockCandidates(db, NOW);
    expect(picked.map((c) => c.variantCode)).toEqual(["62780ovr/42"]);
  });
});
