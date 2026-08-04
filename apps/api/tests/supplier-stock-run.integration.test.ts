import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { supplierStock } from "../src/db/schema.js";
import type { PageFetchResult } from "../src/modules/supplier-stock/page-fetcher.js";
import { runSupplierStock } from "../src/modules/supplier-stock/run.js";
import { withCleanDb } from "./helpers/db.js";
import { insertTestVariant, insertTestVariantForProduct } from "./helpers/orders.js";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../src/modules/supplier-stock/fixtures/${name}`, import.meta.url)),
    "utf8",
  );
}

const LASTING_BONY = fixture("lasting-bony-cepica-l-xl.html");
const LASTING_HILA = fixture("lasting-hila-tricko-bez-xs.html");
const LASTING_BONY_URL =
  "https://shop.lasting.eu/cs/cepice/19937-59938-lasting-merino-cepice-bony-cerna-8595067820460.html";
const LASTING_HILA_URL =
  "https://shop.lasting.eu/cs/trika-kratky-rukav-mqc/16926-56344-hila-damske-merino-triko-s-tiskem-8995067844631.html";

// Žiadny test nesmie siahnuť na skutočnú stránku dodávateľa — sťahovanie je
// vždy vlastná implementácia, nikdy `fetchSupplierPage`.
const okPage = (html: string): PageFetchResult => ({ ok: true, html, httpStatus: 200, error: null });
const failPage = (): PageFetchResult => ({ ok: false, html: "", httpStatus: null, error: "časový limit" });

const IN_STOCK = `<script type="application/ld+json">
  {"@type":"Product","offers":{"@type":"Offer","availability":"https://schema.org/InStock","price":"12,50"}}
</script>`;
const OUT_OF_STOCK = `<script type="application/ld+json">
  {"@type":"Product","offers":{"@type":"Offer","availability":"https://schema.org/OutOfStock"}}
</script>`;

const NOW = new Date("2026-08-03T04:20:00.000Z");
const noSleep = (): Promise<void> => Promise.resolve();

describe("beh dodávateľského skladu", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await withCleanDb());
  });
  afterEach(async () => {
    await close();
  });

  const row = async (link: string): Promise<typeof supplierStock.$inferSelect | undefined> => {
    const [found] = await db.select().from(supplierStock).where(eq(supplierStock.link, link));
    return found;
  };

  it("skontroluje každý odkaz z katalógu a zapíše dostupnosť aj cenu", async () => {
    await insertTestVariant(db, "A1", "Dod 1", { internalNote: "https://huntingshop.eu/a" });
    await insertTestVariant(db, "B1", "Dod 2", { internalNote: "Dodávateľ: X - https://wetland.sk/b" });

    const result = await runSupplierStock({
      db,
      now: NOW,
      sleep: noSleep,
      fetchPage: (url) => Promise.resolve(okPage(url.includes("huntingshop") ? IN_STOCK : OUT_OF_STOCK)),
    });

    expect(result).toMatchObject({ total: 2, checked: 2, available: 1, unavailable: 1, failed: 0 });
    const a = await row("https://huntingshop.eu/a");
    expect(a?.availability).toBe("available");
    expect(a?.price).toBe("12.50");
    expect(a?.confirmedAt).not.toBeNull();
    expect((await row("https://wetland.sk/b"))?.availability).toBe("unavailable");
  });

  it("produkt bez odkazu na dodávateľa sa vôbec nekontroluje", async () => {
    await insertTestVariant(db, "C1", "Dod 3", { internalNote: "Soxland (bez odkazu)" });

    const result = await runSupplierStock({ db, now: NOW, sleep: noSleep, fetchPage: () => Promise.resolve(okPage(IN_STOCK)) });

    expect(result.total).toBe(0);
    expect(result.checked).toBe(0);
  });

  // Nečitateľná stránka NESMIE vyzerať ako potvrdenie — inak by automatizácia
  // (issue 213) prepla produkt na základe dohadu.
  it("nečitateľná stránka skončí ako „neviem\" a NEPOTVRDÍ dostupnosť", async () => {
    await insertTestVariant(db, "D1", "Dod 4", { internalNote: "https://dogtrace.com/d" });

    const result = await runSupplierStock({
      db,
      now: NOW,
      sleep: noSleep,
      fetchPage: () => Promise.resolve(okPage("<html><body>Popis produktu, žiadna dostupnosť</body></html>")),
    });

    expect(result.unknown).toBe(1);
    const d = await row("https://dogtrace.com/d");
    expect(d?.availability).toBe("unknown");
    expect(d?.ok).toBe(true);
    expect(d?.confirmedAt).toBeNull();
  });

  it("zlyhaná kontrola sa zapíše ako chyba, nie ako dostupnosť", async () => {
    await insertTestVariant(db, "E1", "Dod 5", { internalNote: "https://huntingshop.eu/e" });

    const result = await runSupplierStock({ db, now: NOW, sleep: noSleep, fetchPage: () => Promise.resolve(failPage()) });

    expect(result.failed).toBe(1);
    const e = await row("https://huntingshop.eu/e");
    expect(e?.ok).toBe(false);
    expect(e?.error).toBe("časový limit");
    expect(e?.availability).toBe("unknown");
  });

  it("odkaz s čerstvým potvrdením sa znovu nesťahuje", async () => {
    await insertTestVariant(db, "F1", "Dod 6", { internalNote: "https://huntingshop.eu/f" });
    await runSupplierStock({ db, now: NOW, sleep: noSleep, fetchPage: () => Promise.resolve(okPage(IN_STOCK)) });

    let volani = 0;
    const oHodinuNeskor = new Date(NOW.getTime() + 3_600_000);
    const result = await runSupplierStock({
      db,
      now: oHodinuNeskor,
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

  // Bez tohto by stránka, ktorá stabilne padá na časovom limite, ostala
  // navždy „čerstvá" a nikdy by sa neskúsila znova.
  it("odkaz so zlyhanou kontrolou sa skúsi znova, aj keď je zápis čerstvý", async () => {
    await insertTestVariant(db, "G1", "Dod 7", { internalNote: "https://huntingshop.eu/g" });
    await runSupplierStock({ db, now: NOW, sleep: noSleep, fetchPage: () => Promise.resolve(failPage()) });

    const result = await runSupplierStock({
      db,
      now: new Date(NOW.getTime() + 60_000),
      sleep: noSleep,
      fetchPage: () => Promise.resolve(okPage(IN_STOCK)),
    });

    expect(result.checked).toBe(1);
    expect((await row("https://huntingshop.eu/g"))?.availability).toBe("available");
  });

  // Výpadok siete nesmie zahodiť potvrdenie, ktoré má ešte platnosť —
  // automatizácia (issue 213) ho nechá dožiť svoje 48 hodín a potom prestane.
  it("zlyhanie po úspechu nechá staré potvrdenie dožiť, len ho neposunie", async () => {
    await insertTestVariant(db, "H1", "Dod 8", { internalNote: "https://huntingshop.eu/h" });
    await runSupplierStock({ db, now: NOW, sleep: noSleep, fetchPage: () => Promise.resolve(okPage(IN_STOCK)) });
    const povodne = (await row("https://huntingshop.eu/h"))?.confirmedAt;

    const neskor = new Date(NOW.getTime() + 25 * 3_600_000);
    await runSupplierStock({ db, now: neskor, sleep: noSleep, fetchPage: () => Promise.resolve(failPage()) });

    const h = await row("https://huntingshop.eu/h");
    expect(h?.ok).toBe(false);
    expect(h?.confirmedAt?.toISOString()).toBe(povodne?.toISOString());
    expect(h?.checkedAt.toISOString()).toBe(neskor.toISOString());
  });

  it("tá istá linka na viacerých produktoch sa sťahuje len raz", async () => {
    await insertTestVariant(db, "I1", "Dod 9", { internalNote: "https://huntingshop.eu/spolocna" });
    await insertTestVariant(db, "I2", "Dod 9", { internalNote: "https://huntingshop.eu/spolocna" });

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

    expect(result.total).toBe(1);
    expect(volani).toBe(1);
  });
});

// issue 224 — dostupnosť sa berie za KONKRÉTNU veľkosť, nie za celý odkaz.
// Oba príklady priamo z ticketu, na uložených vzorkách reálnych stránok.
describe("beh dodávateľského skladu — issue 224: dostupnosť po veľkosti", () => {
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

  it("16707/L-X (nas 'L-X' = dodavatelovo 'L/XL', sklademNE) je unavailable, nie available z JSON-LD", async () => {
    await insertTestVariantForProduct(db, "16707", "16707/L-X", {
      sizeLabel: "L-X",
      internalNote: LASTING_BONY_URL,
    });
    await insertTestVariantForProduct(db, "16707", "16707/S-M", { sizeLabel: "S-M" });

    await runSupplierStock({
      db,
      now: NOW,
      sleep: noSleep,
      fetchPage: () => Promise.resolve(okPage(LASTING_BONY)),
    });

    const lx = await rowFor(LASTING_BONY_URL, "L-X");
    expect(lx?.availability).toBe("unavailable");
    expect(lx?.source).toBe("size_list");
    expect(lx?.availabilityText).toBe("L/XL");

    // Druhá veľkosť tej istej linky sa spáruje NEZÁVISLE — dodávateľ ju má
    // skladom, hoci L/XL nie.
    const sm = await rowFor(LASTING_BONY_URL, "S-M");
    expect(sm?.availability).toBe("available");
  });

  it("16710/XS (dodavatel tuto velkost vobec nema) je unknown, nikdy dohad", async () => {
    await insertTestVariantForProduct(db, "16710", "16710/XS", {
      sizeLabel: "XS",
      internalNote: LASTING_HILA_URL,
    });
    await insertTestVariantForProduct(db, "16710", "16710/L", { sizeLabel: "L" });

    await runSupplierStock({
      db,
      now: NOW,
      sleep: noSleep,
      fetchPage: () => Promise.resolve(okPage(LASTING_HILA)),
    });

    const xs = await rowFor(LASTING_HILA_URL, "XS");
    expect(xs?.availability).toBe("unknown");
    expect(xs?.confirmedAt).toBeNull();

    const l = await rowFor(LASTING_HILA_URL, "L");
    expect(l?.availability).toBe("available");
  });

  it("jednoveľkostný odkaz na doméne s pravidlom stále funguje ako blanket riadok", async () => {
    // Bez DRUHÉHO variantu na tej istej linke sa `ourSizes.length` rovná 1,
    // nie 0 — čítač sa STÁLE pokúsi spárovať jedinú veľkosť, presne ako pri
    // viacerých variantoch.
    await insertTestVariantForProduct(db, "16707solo", "16707solo/L-X", {
      sizeLabel: "L-X",
      internalNote: LASTING_BONY_URL,
    });

    await runSupplierStock({
      db,
      now: NOW,
      sleep: noSleep,
      fetchPage: () => Promise.resolve(okPage(LASTING_BONY)),
    });

    const lx = await rowFor(LASTING_BONY_URL, "L-X");
    expect(lx?.availability).toBe("unavailable");
  });
});
