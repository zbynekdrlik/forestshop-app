import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/client.js";
import { products, restockEvents, shopProductUrl, supplierStock, variants } from "../src/db/schema.js";
import type { ShoptetImportConfig } from "../src/modules/shoptet-writeback/config.js";
import { runRestock, setRestockEnabled } from "../src/modules/restock/run.js";
import { listRestockEvents, listRestockWaiting, selectRestockCandidates } from "../src/modules/restock/queries.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";

const NOW = new Date("2026-08-04T04:50:00.000Z");
const LINK = "https://huntingshop.eu/bunda";

// Žiadny test nesmie siahnuť na skutočný Shoptet — zápis je vždy vlastná
// implementácia, nikdy `runShoptetImport`.
const CONFIG: ShoptetImportConfig = {
  loginUrl: "https://example.invalid/admin/",
  importUrl: "https://example.invalid/admin/import-produktov/",
  logUrl: "https://example.invalid/admin/import-produktov/log/",
  user: "test",
  password: "test",
};

describe("prepínanie Vypredané → Skladom", () => {
  let db: Database;
  let close: () => Promise<void>;
  let snapshotId: string;

  beforeEach(async () => {
    ({ db, close } = await withCleanDb());
    snapshotId = await insertTestSnapshot(db);
    await setRestockEnabled(db, true, NOW);
  });
  afterEach(async () => {
    await close();
  });

  const seedSupplierStock = async (over: Partial<typeof supplierStock.$inferInsert> = {}): Promise<void> => {
    await db.insert(supplierStock).values({
      link: LINK,
      host: "huntingshop.eu",
      availability: "available",
      availabilityText: "skladom",
      price: "12.50",
      source: "json_ld",
      ok: true,
      error: null,
      httpStatus: 200,
      checkedAt: NOW,
      confirmedAt: new Date(NOW.getTime() - 3_600_000),
      ...over,
    });
  };

  const seedVariant = async (
    code: string,
    over: {
      readonly state?: "sellable" | "out_of_stock" | "discontinued";
      readonly productVisibility?: string;
      readonly internalNote?: string | null;
      readonly missingSince?: Date | null;
      // issue 224: viac variantov (veľkostí) toho istého produktu, keď
      // zdieľajú tú istú linku, potrebuje SPOLOČNÝ productKey — inak by
      // každý `code` dostal vlastný produkt s vlastným `internalNote`.
      readonly productKey?: string;
      readonly sizeLabel?: string | null;
    } = {},
  ): Promise<void> => {
    const productKey = over.productKey ?? `prod-${code}`;
    await db
      .insert(products)
      .values({
        key: productKey,
        name: `Produkt ${code}`,
        supplier: "Dodávateľ",
        internalNote: over.internalNote === undefined ? LINK : over.internalNote,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        lastSeenSnapshotId: snapshotId,
      })
      .onConflictDoNothing();
    await db.insert(variants).values({
      code,
      productKey,
      guid: productKey,
      sizeLabel: over.sizeLabel ?? null,
      name: `Produkt ${code}`,
      stock: 0,
      availabilityInStockText: "Skladom",
      availabilityOutOfStockText: "Vypredané",
      availabilityText: "Vypredané",
      productVisibility: over.productVisibility ?? "visible",
      state: over.state ?? "out_of_stock",
      missingSince: over.missingSince ?? null,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      lastSeenSnapshotId: snapshotId,
    });
  };

  const okImport = vi.fn(() =>
    Promise.resolve({ ok: true as const, processed: 1, updated: 1, failed: 0, errorDetail: null, rawResultText: "OK" }),
  );

  it("prepne vypredaný viditeľný produkt, ktorý dodávateľ potvrdene má", async () => {
    await seedSupplierStock();
    await seedVariant("A1");

    const result = await runRestock({ db, now: NOW, config: CONFIG, importToShoptet: okImport });

    expect(result).toMatchObject({ status: "ok", switched: 1, codes: ["A1"] });
    const [event] = await db.select().from(restockEvents).where(eq(restockEvents.variantCode, "A1"));
    expect(event?.supplierLink).toBe(LINK);
    expect(event?.supplierAvailabilityText).toBe("skladom");
  });

  // issue 224: jedna linka môže niesť VIAC riadkov naraz (jeden na každú
  // veľkosť) — variant sa smie prepnúť LEN keď je dostupný RIADOK jeho
  // VLASTNEJ veľkosti, nikdy podľa dostupnosti inej veľkosti tej istej linky.
  it("z linky s viacerými veľkosťami sa prepne LEN variant svojej vlastnej dostupnej veľkosti", async () => {
    await seedSupplierStock({ sizeLabel: "L-X", availability: "available" });
    await seedSupplierStock({ sizeLabel: "S-M", availability: "unavailable" });
    await seedVariant("16707/L-X", { productKey: "prod-16707", sizeLabel: "L-X" });
    await seedVariant("16707/S-M", { productKey: "prod-16707", sizeLabel: "S-M" });

    const { picked } = await selectRestockCandidates(db, NOW);

    expect(picked.map((c) => c.variantCode)).toEqual(["16707/L-X"]);
  });

  // TOTO je hlavná bezpečnostná podmienka celej úlohy: `detailOnly` je vedomé
  // rozhodnutie majiteľa produkt nepredávať a má ROVNAKÝ stav `out_of_stock`
  // ako bežné vypredané (na reálnom exporte 526 riadkov).
  it("NIKDY neprepne detailOnly ani inú skrytú viditeľnosť", async () => {
    await seedSupplierStock();
    for (const [code, visibility] of [
      ["B1", "detailOnly"],
      ["B2", "hidden"],
      ["B3", "blocked"],
      ["B4", "cashDeskOnly"],
      ["B5", "blockUnregistered"],
    ] as const) {
      await seedVariant(code, { productVisibility: visibility });
    }

    const { picked } = await selectRestockCandidates(db, NOW);

    expect(picked).toHaveLength(0);
  });

  it("neprepne produkt, ktorý už je predajný (idempotencia)", async () => {
    await seedSupplierStock();
    await seedVariant("C1", { state: "sellable" });

    expect((await selectRestockCandidates(db, NOW)).picked).toHaveLength(0);
  });

  it("neprepne produkt s ukončeným predajom", async () => {
    await seedSupplierStock();
    await seedVariant("D1", { state: "discontinued" });

    expect((await selectRestockCandidates(db, NOW)).picked).toHaveLength(0);
  });

  it("neprepne variant, ktorý zmizol z exportu", async () => {
    await seedSupplierStock();
    await seedVariant("E1", { missingSince: NOW });

    expect((await selectRestockCandidates(db, NOW)).picked).toHaveLength(0);
  });

  it("neprepne na základe nečitateľnej stránky ani zlyhanej kontroly", async () => {
    await seedSupplierStock({ availability: "unknown", confirmedAt: null });
    await seedVariant("F1");
    expect((await selectRestockCandidates(db, NOW)).picked).toHaveLength(0);

    await db.update(supplierStock).set({ ok: false, availability: "available" }).where(eq(supplierStock.link, LINK));
    expect((await selectRestockCandidates(db, NOW)).picked).toHaveLength(0);
  });

  it("neprepne na základe zastaraného potvrdenia", async () => {
    await seedSupplierStock({ confirmedAt: new Date(NOW.getTime() - 49 * 3_600_000) });
    await seedVariant("G1");

    expect((await selectRestockCandidates(db, NOW)).picked).toHaveLength(0);
  });

  it("neprepne produkt bez dodávateľskej linky", async () => {
    await seedSupplierStock();
    await seedVariant("H1", { internalNote: "Soxland (bez odkazu)" });

    expect((await selectRestockCandidates(db, NOW)).picked).toHaveLength(0);
  });

  // Rozhodnutie majiteľa: najviac 50 za beh, zvyšok počká a appka to napíše.
  it("drží strop prepnutí za jeden beh a povie, koľko ich čaká", async () => {
    await seedSupplierStock();
    for (let i = 0; i < 5; i += 1) await seedVariant(`I${String(i)}`);

    const result = await runRestock({ db, now: NOW, config: CONFIG, importToShoptet: okImport, limit: 2 });

    expect(result).toMatchObject({ status: "ok", switched: 2, overLimit: 3 });
    expect(await db.select().from(restockEvents)).toHaveLength(2);
  });

  // Import do Shoptetu je všetko-alebo-nič — tvrdiť, že sa niečo preplo,
  // by po zlyhaní bola lož.
  it("po zlyhaní zápisu do Shoptetu nezapíše ŽIADNE prepnutie", async () => {
    await seedSupplierStock();
    await seedVariant("J1");
    const zlyhanie = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        processed: 0,
        updated: 0,
        failed: 1,
        errorDetail: "prihlásenie zlyhalo",
        rawResultText: "",
      }),
    );

    const result = await runRestock({ db, now: NOW, config: CONFIG, importToShoptet: zlyhanie });

    expect(result).toMatchObject({ status: "failed", attempted: 1 });
    expect(await db.select().from(restockEvents)).toHaveLength(0);
  });

  // issue 217 — overovací zoznam pre majiteľa. Kľúčová vlastnosť: musí ukazovať
  // PRESNE to, čo automatizácia prepne, len bez stropu a po stránkach.
  it("overovací zoznam ukáže aj kandidátov nad stropom a spočíta dodávateľov", async () => {
    await seedSupplierStock();
    for (let i = 0; i < 5; i += 1) await seedVariant(`W${String(i)}`);

    const prva = await listRestockWaiting(db, NOW, { limit: 2, offset: 0 });
    expect(prva.total).toBe(5);
    expect(prva.rows).toHaveLength(2);
    expect(prva.suppliers).toEqual([{ name: "Dodávateľ", count: 5 }]);

    const druha = await listRestockWaiting(db, NOW, { limit: 2, offset: 2 });
    expect(druha.rows.map((r) => r.variantCode)).not.toEqual(prva.rows.map((r) => r.variantCode));
  });

  // issue 220 — majiteľ o pôvodných odkazoch: „tie linky na nase produkty su
  // uplne hrozne". Adresa detailu prichádza z feedu pre porovnávače; kód, ktorý
  // vo feede nie je, NESMIE zo zoznamu vypadnúť (inak by sa prepol produkt,
  // ktorý majiteľ nikdy nevidel — trieda chyby z issue 219).
  it("overovací zoznam nesie priamu adresu z feedu a bez nej riadok nezahodí", async () => {
    await seedSupplierStock();
    await seedVariant("U1");
    await seedVariant("U2");
    await db.insert(shopProductUrl).values({
      code: "U1",
      url: "https://www.forestshop.sk/bunda/?variantId=4211",
      fetchedAt: NOW,
    });

    const zoznam = await listRestockWaiting(db, NOW, { limit: 50, offset: 0 });
    expect(zoznam.total).toBe(2);
    expect(
      Object.fromEntries(zoznam.rows.map((r) => [r.variantCode, r.ourUrl])),
    ).toEqual({
      U1: "https://www.forestshop.sk/bunda/?variantId=4211",
      U2: null,
    });
  });

  it("overovací zoznam filtruje podľa dodávateľa", async () => {
    await seedSupplierStock();
    await seedVariant("X1");
    await db.update(products).set({ supplier: "Iný" }).where(eq(products.key, "prod-X1"));
    await seedVariant("X2");

    expect((await listRestockWaiting(db, NOW, { limit: 50, offset: 0, supplier: "Iný" })).total).toBe(1);
    expect((await listRestockWaiting(db, NOW, { limit: 50, offset: 0, supplier: "Dodávateľ" })).total).toBe(1);
  });

  // Zoznam, podľa ktorého sa majiteľ rozhoduje, sa nesmie rozísť s výberom
  // nočného behu — inak by overil jedno a prepli by sa iné produkty.
  it("overovací zoznam vylučuje detailOnly rovnako ako samotné prepínanie", async () => {
    await seedSupplierStock();
    await seedVariant("Y1", { productVisibility: "detailOnly" });

    expect((await listRestockWaiting(db, NOW, { limit: 50, offset: 0 })).total).toBe(0);
  });

  it("bez kandidátov do Shoptetu vôbec nesiahne", async () => {
    const import_ = vi.fn();
    const result = await runRestock({ db, now: NOW, config: CONFIG, importToShoptet: import_ });

    expect(result).toMatchObject({ status: "nothing_to_do" });
    expect(import_).not.toHaveBeenCalled();
  });

  // issue 226: keď Shoptetov VLASTNÝ feed hovorí "skladom" pre variant, ktorý
  // MY vedieme ako vypredané, naše odvodenie je podozrivé — kandidátom sa
  // nesmie stať, kým sa rozpor nevysvetlí (rovnaký princíp ako "unknown"
  // v issue 213 — radšej sa nedotknúť, než hádať).
  it("nevyberie kandidáta, ktorého náš vypredaný stav odporuje feedu 'skladom'", async () => {
    await seedSupplierStock();
    await seedVariant("Z1");
    await db.insert(shopProductUrl).values({
      code: "Z1",
      url: "https://www.forestshop.sk/z1/",
      availability: "in stock",
      fetchedAt: NOW,
    });

    expect((await selectRestockCandidates(db, NOW)).picked).toHaveLength(0);
  });

  it("VYBERIE kandidáta, ktorého feed potvrdzuje 'vypredané' (zhoda, nie rozpor)", async () => {
    await seedSupplierStock();
    await seedVariant("Z2");
    await db.insert(shopProductUrl).values({
      code: "Z2",
      url: "https://www.forestshop.sk/z2/",
      availability: "out of stock",
      fetchedAt: NOW,
    });

    expect((await selectRestockCandidates(db, NOW)).picked.map((c) => c.variantCode)).toEqual(["Z2"]);
  });

  it("kandidát bez feed riadku (mimo feedu) sa vyberie ako predtým — chýbajúci signál nie je rozpor", async () => {
    await seedSupplierStock();
    await seedVariant("Z3");

    expect((await selectRestockCandidates(db, NOW)).picked.map((c) => c.variantCode)).toEqual(["Z3"]);
  });

  // issue 329 — história prepnutí teraz nesie aj odkaz na náš produkt z
  // feedu, chýbajúci feed riadok sa nesmie zamlčať výnimkou/pádom.
  it("história prepnutí nesie priamu adresu z feedu a bez nej riadok nezahodí", async () => {
    await seedSupplierStock();
    await seedVariant("V1");
    await seedVariant("V2");
    await db.insert(shopProductUrl).values({ code: "V1", url: "https://www.forestshop.sk/v1/", fetchedAt: NOW });

    await runRestock({ db, now: NOW, config: CONFIG, importToShoptet: okImport });

    const udalosti = await listRestockEvents(db, 200);
    expect(
      Object.fromEntries(udalosti.map((u) => [u.variantCode, u.ourUrl])),
    ).toEqual({ V1: "https://www.forestshop.sk/v1/", V2: null });
  });
});
