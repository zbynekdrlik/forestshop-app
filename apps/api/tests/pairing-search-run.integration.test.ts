import { eq } from "drizzle-orm";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { pairingCandidateSets, pairingCandidates, products, suppliers, variants } from "../src/db/schema.js";
import { SearchClient, type Fetcher } from "../src/modules/pairing-search/client.js";
import { PAIRING_SEARCH_RUN_LOCK_KEY } from "../src/modules/pairing-search/constants.js";
import { runPairingSearch } from "../src/modules/pairing-search/run.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";

const NOW = new Date("2026-08-13T03:35:00.000Z");
const LATER = new Date("2026-08-14T03:35:00.000Z");

let close: (() => Promise<void>) | undefined;
let checker: pg.Client | undefined;

afterEach(async () => {
  await checker?.end();
  checker = undefined;
  await close?.();
  close = undefined;
});

async function boot(): Promise<Database> {
  const ctx = await withCleanDb();
  close = ctx.close;
  return ctx.db;
}

async function seedSupplier(db: Database, name: string, adapterKey: string | null): Promise<void> {
  await db.insert(suppliers).values({ name, currency: "EUR", wholesaleBaseUrl: "https://www.wetland.sk", adapterKey });
}

interface SeedProductOptions {
  readonly supplier?: string | null;
  readonly internalNote?: string | null;
  readonly externalCode?: string | null;
  readonly state?: "sellable" | "out_of_stock" | "discontinued";
  readonly productVisibility?: string;
  readonly missingSince?: Date | null;
  readonly name?: string;
}

async function seedProduct(db: Database, key: string, opts: SeedProductOptions = {}): Promise<void> {
  const snapshotId = await insertTestSnapshot(db);
  await db.insert(products).values({
    key,
    name: opts.name ?? `Bunda ${key}`,
    supplier: opts.supplier === undefined ? "WETLAND" : opts.supplier,
    internalNote: opts.internalNote ?? null,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastSeenSnapshotId: snapshotId,
  });
  await db.insert(variants).values({
    code: `${key}-V1`,
    productKey: key,
    guid: key,
    sizeLabel: null,
    pairCode: null,
    externalCode: opts.externalCode ?? null,
    name: opts.name ?? `Bunda ${key}`,
    currency: "EUR",
    price: "10.00",
    stock: 5,
    availabilityInStockText: "Skladom",
    availabilityOutOfStockText: "Vypredané",
    availabilityText: "Skladom",
    productVisibility: opts.productVisibility ?? "visible",
    state: opts.state ?? "sellable",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastSeenSnapshotId: snapshotId,
    missingSince: opts.missingSince ?? null,
  });
}

/** Minimálna WETLAND vyhľadávacia karta — presne selektor `wetland.ts`
 * očakáva (`div.product-miniature__title a.link`). */
function wetlandCard(name: string, href: string): string {
  return `<div class="product-miniature__title"><a class="link" href="${href}">${name}</a></div>`;
}

function fakeWetlandFetcher(html: string, onCall?: (url: string) => void): Fetcher {
  return (url) => {
    onCall?.(url);
    return Promise.resolve(html);
  };
}

describe("pairing-search: gather beh (issue 387 E3)", () => {
  it("zapíše chosen_url a top kandidátov pre eligible produkt (menová zhoda, medium)", async () => {
    const db = await boot();
    await seedSupplier(db, "WETLAND", "wetland");
    await seedProduct(db, "P1", { name: "Bunda Wetland" });

    const html = `<div>${wetlandCard("Bunda Wetland", "https://www.wetland.sk/p/1")}${wetlandCard("Úplne iný produkt", "https://www.wetland.sk/p/2")}</div>`;
    const searchClient = new SearchClient({ fetcher: fakeWetlandFetcher(html) });

    const result = await runPairingSearch({ db, now: NOW, searchClient });

    expect(result).toMatchObject({ eligible: 1, processed: 1, succeeded: 1, failed: 0, stoppedEarly: false });

    const [set] = await db.select().from(pairingCandidateSets).where(eq(pairingCandidateSets.productKey, "P1"));
    expect(set?.confidence).toBe("medium");
    expect(set?.chosenUrl).toBe("https://www.wetland.sk/p/1");
    expect(set?.chosenReason).toContain("zhoda mena");
    expect(set?.gatheredAt.toISOString()).toBe(NOW.toISOString());
    expect(set?.queries.length).toBeGreaterThan(0);

    const candidates = await db.select().from(pairingCandidates).where(eq(pairingCandidates.productKey, "P1"));
    expect(candidates).toHaveLength(2);
    expect(candidates.find((c) => c.position === 0)?.url).toBe("https://www.wetland.sk/p/1");
  });

  it("kódová zhoda vždy vyhrá nad menovou (confidence high, aj keď meno nesedí)", async () => {
    const db = await boot();
    await seedSupplier(db, "WETLAND", "wetland");
    await seedProduct(db, "P1", { name: "Nohavice X", externalCode: "KOD777" });

    const html = `<div>${wetlandCard("Úplne iný text KOD777 model", "https://www.wetland.sk/p/kod")}${wetlandCard("Nohavice X", "https://www.wetland.sk/p/name")}</div>`;
    const searchClient = new SearchClient({ fetcher: fakeWetlandFetcher(html) });

    const result = await runPairingSearch({ db, now: NOW, searchClient });

    expect(result.succeeded).toBe(1);
    const [set] = await db.select().from(pairingCandidateSets).where(eq(pairingCandidateSets.productKey, "P1"));
    expect(set?.confidence).toBe("high");
    expect(set?.chosenUrl).toBe("https://www.wetland.sk/p/kod");
    expect(set?.chosenReason).toBe("kód dodávateľa sa zhoduje");

    const chosen = await db
      .select()
      .from(pairingCandidates)
      .where(eq(pairingCandidates.productKey, "P1"));
    expect(chosen.find((c) => c.url === "https://www.wetland.sk/p/kod")?.codeHit).toBe(true);
  });

  it("produkt s dodávateľom BEZ známeho adaptéra sa nikdy nevyberie", async () => {
    const db = await boot();
    await seedSupplier(db, "WETLAND", "wetland");
    await seedProduct(db, "P1", { supplier: "CUDZÍ DODÁVATEĽ NEZNÁMY" });

    const searchClient = new SearchClient({ fetcher: fakeWetlandFetcher("<div></div>") });
    const result = await runPairingSearch({ db, now: NOW, searchClient });

    expect(result).toMatchObject({ eligible: 0, processed: 0 });
    const rows = await db.select().from(pairingCandidateSets);
    expect(rows).toHaveLength(0);
  });

  it("produkt s už existujúcim efektívnym odkazom (internalNote) sa nikdy nevyberie", async () => {
    const db = await boot();
    await seedSupplier(db, "WETLAND", "wetland");
    await seedProduct(db, "P1", { internalNote: "https://existing.example.com/produkt" });

    const searchClient = new SearchClient({ fetcher: fakeWetlandFetcher("<div></div>") });
    const result = await runPairingSearch({ db, now: NOW, searchClient });

    expect(result).toMatchObject({ eligible: 0, processed: 0 });
  });

  it("inkrementálnosť: nezmenený produkt sa na DRUHOM behu nevyberie znova (input_hash sedí)", async () => {
    const db = await boot();
    await seedSupplier(db, "WETLAND", "wetland");
    await seedProduct(db, "P1", { name: "Bunda Wetland" });

    let calls = 0;
    const html = `<div>${wetlandCard("Bunda Wetland", "https://www.wetland.sk/p/1")}</div>`;
    const searchClient = new SearchClient({
      fetcher: fakeWetlandFetcher(html, () => {
        calls += 1;
      }),
    });

    await runPairingSearch({ db, now: NOW, searchClient });
    expect(calls).toBeGreaterThan(0);
    const callsAfterFirstRun = calls;

    const second = await runPairingSearch({ db, now: LATER, searchClient });

    expect(second).toMatchObject({ eligible: 0, processed: 0 });
    expect(calls).toBe(callsAfterFirstRun);

    const [set] = await db.select().from(pairingCandidateSets).where(eq(pairingCandidateSets.productKey, "P1"));
    expect(set?.gatheredAt.toISOString()).toBe(NOW.toISOString());
  });

  it("zmena mena produktu (iný input_hash) ho spraví znova eligible", async () => {
    const db = await boot();
    await seedSupplier(db, "WETLAND", "wetland");
    await seedProduct(db, "P1", { name: "Bunda Wetland" });

    const html = `<div>${wetlandCard("Bunda Wetland", "https://www.wetland.sk/p/1")}</div>`;
    const searchClient = new SearchClient({ fetcher: fakeWetlandFetcher(html) });
    await runPairingSearch({ db, now: NOW, searchClient });

    await db.update(products).set({ name: "Bunda Wetland Nová" }).where(eq(products.key, "P1"));

    const second = await runPairingSearch({ db, now: LATER, searchClient });

    expect(second).toMatchObject({ eligible: 1, succeeded: 1 });
    const [set] = await db.select().from(pairingCandidateSets).where(eq(pairingCandidateSets.productKey, "P1"));
    expect(set?.gatheredAt.toISOString()).toBe(LATER.toISOString());
  });

  // Design komentár na tickete ("Zvolený prístup"): checkpoint = per-produkt
  // transakcia, ŽIADNA cursor tabuľka — obnoviteľnosť príde ZADARMO z
  // input_hash. Tento test to dokazuje: produkt, pri ktorom sieťové
  // volanie vyhodí, sa NEZAPÍŠE (zostáva eligible pre ďalší beh), zatiaľ čo
  // SÚRODENSKÝ produkt v TOM ISTOM behu sa committne a na ĎALŠOM behu sa
  // už NEOPAKUJE.
  it("obnoviteľnosť po páde uprostred: zlyhaný produkt sa zaloguje, pokračuje sa, ostatné sa committnú a na ďalšom behu sa neopakujú", async () => {
    const db = await boot();
    await seedSupplier(db, "WETLAND", "wetland");
    await seedProduct(db, "OK", { name: "Bunda OK" });
    await seedProduct(db, "FAIL", { name: "Bunda FAIL" });

    let okCalls = 0;
    const failingFetcher: Fetcher = (url) => {
      if (url.includes("FAIL") || url.toLowerCase().includes("fail")) {
        return Promise.reject(new Error("simulovaný sieťový pád"));
      }
      okCalls += 1;
      return Promise.resolve(`<div>${wetlandCard("Bunda OK", "https://www.wetland.sk/p/ok")}</div>`);
    };
    const failingClient = new SearchClient({ fetcher: failingFetcher });

    const first = await runPairingSearch({ db, now: NOW, searchClient: failingClient });

    expect(first).toMatchObject({ eligible: 2, processed: 2, succeeded: 1, failed: 1 });
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]?.productKey).toBe("FAIL");
    expect(first.errors[0]?.message).toContain("simulovaný sieťový pád");
    expect(okCalls).toBeGreaterThan(0);

    const okSet = await db.select().from(pairingCandidateSets).where(eq(pairingCandidateSets.productKey, "OK"));
    expect(okSet).toHaveLength(1);
    const failSet = await db.select().from(pairingCandidateSets).where(eq(pairingCandidateSets.productKey, "FAIL"));
    expect(failSet).toHaveLength(0);

    // Druhý beh (opravená appka/sieť) — fixnutý fetcher, ktorý loguje volania.
    const secondCalls: string[] = [];
    const fixedClient = new SearchClient({
      fetcher: fakeWetlandFetcher(`<div>${wetlandCard("Bunda FAIL", "https://www.wetland.sk/p/fail")}</div>`, (url) => {
        secondCalls.push(url);
      }),
    });

    const second = await runPairingSearch({ db, now: LATER, searchClient: fixedClient });

    // LEN "FAIL" je eligible — "OK" má nezmenený input_hash, ďalší beh ho
    // vôbec nevyberie (žiadne ĎALŠIE sieťové volanie preň).
    expect(second).toMatchObject({ eligible: 1, processed: 1, succeeded: 1, failed: 0 });
    expect(secondCalls.length).toBeGreaterThan(0);
    const failSetAfter = await db.select().from(pairingCandidateSets).where(eq(pairingCandidateSets.productKey, "FAIL"));
    expect(failSetAfter[0]?.chosenUrl).toBe("https://www.wetland.sk/p/fail");
  });

  // Design komentár: časový (nie počtový) strop + "prioritne vypredané-
  // viditeľné" (návrh sekcia 5 bod 3) — kombinovaný dôkaz oboch naraz.
  it("časový strop zastaví beh PO prvom produkte a spracuje PRIORITNE vypredaný-viditeľný", async () => {
    const db = await boot();
    await seedSupplier(db, "WETLAND", "wetland");
    // Bežný (nie vypredaný) produkt — abecedne PRVÝ, aby bez priority
    // vyhrával on.
    await seedProduct(db, "A-BEZNY", { name: "Bunda A", state: "sellable" });
    // Vypredaný-viditeľný — má prednosť napriek abecedne neskoršiemu kľúču.
    await seedProduct(db, "B-VYPREDANY", {
      name: "Bunda B",
      state: "out_of_stock",
      productVisibility: "visible",
      missingSince: null,
    });

    const html = `<div>${wetlandCard("Bunda", "https://www.wetland.sk/p/x")}</div>`;
    const searchClient = new SearchClient({ fetcher: fakeWetlandFetcher(html) });

    const clockValues = [0, 0, 1000];
    let clockIndex = 0;
    const clock = (): number => clockValues[clockIndex++] ?? 1000;

    const result = await runPairingSearch({ db, now: NOW, searchClient, timeBudgetMs: 1, clock });

    expect(result).toMatchObject({ eligible: 2, processed: 1, succeeded: 1, stoppedEarly: true });

    const vypredanySet = await db.select().from(pairingCandidateSets).where(eq(pairingCandidateSets.productKey, "B-VYPREDANY"));
    expect(vypredanySet).toHaveLength(1);
    const beznySet = await db.select().from(pairingCandidateSets).where(eq(pairingCandidateSets.productKey, "A-BEZNY"));
    expect(beznySet).toHaveLength(0);
  });

  // Rovnaká DETERMINISTICKÁ technika ako `posta-uncollected-run.integration
  // .test.ts`'s "dva súbežné behy sa serializujú" — `pg_try_advisory_lock`
  // (neblokujúci) z DRUHÉHO pripojenia MUSÍ zlyhať, kým je beh zaseknutý na
  // falošnom, ešte nevyriešenom sieťovom volaní.
  it("dva súbežné behy sa serializujú (advisory zámok 787_878_007), nikdy neprebehnú naraz", async () => {
    const db = await boot();
    await seedSupplier(db, "WETLAND", "wetland");
    await seedProduct(db, "P1", { name: "Bunda Wetland" });

    let releaseFetch: (() => void) | undefined;
    const blockedUntilReleased = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const blockingFetcher: Fetcher = async () => {
      await blockedUntilReleased;
      return `<div>${wetlandCard("Bunda Wetland", "https://www.wetland.sk/p/1")}</div>`;
    };
    const blockingClient = new SearchClient({ fetcher: blockingFetcher });

    const runPromise = runPairingSearch({ db, now: NOW, searchClient: blockingClient });

    await new Promise((resolve) => setTimeout(resolve, 100));

    const databaseUrl = process.env["DATABASE_URL"];
    if (databaseUrl === undefined || databaseUrl === "") throw new Error("DATABASE_URL chýba");
    checker = new pg.Client({ connectionString: databaseUrl });
    await checker.connect();
    const midRun = await checker.query<{ pg_try_advisory_lock: boolean }>("select pg_try_advisory_lock($1)", [
      PAIRING_SEARCH_RUN_LOCK_KEY,
    ]);
    expect(midRun.rows[0]?.pg_try_advisory_lock).toBe(false);

    releaseFetch?.();
    await runPromise;

    const afterRun = await checker.query<{ pg_try_advisory_lock: boolean }>("select pg_try_advisory_lock($1)", [
      PAIRING_SEARCH_RUN_LOCK_KEY,
    ]);
    expect(afterRun.rows[0]?.pg_try_advisory_lock).toBe(true);
    await checker.query("select pg_advisory_unlock($1)", [PAIRING_SEARCH_RUN_LOCK_KEY]);
  });
});
