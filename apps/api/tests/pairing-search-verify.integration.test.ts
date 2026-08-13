// Vydelené z `pairing-search-run.integration.test.ts` (issue 387 E4), aby
// ani jeden súbor nenarástol cez eslint `max-lines: 400` (`.claude/rules/
// testing.md`) — E3's gather beh testy zostávajú tam, E4's kódové overenie
// je tu.

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { pairingCandidateSets, products, suppliers, variants } from "../src/db/schema.js";
import { SearchClient, type Fetcher } from "../src/modules/pairing-search/client.js";
import { runPairingSearch } from "../src/modules/pairing-search/run.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";

const NOW = new Date("2026-08-13T03:35:00.000Z");

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

async function boot(): Promise<Database> {
  const ctx = await withCleanDb();
  close = ctx.close;
  return ctx.db;
}

async function seedSupplier(db: Database): Promise<void> {
  await db.insert(suppliers).values({ name: "WETLAND", currency: "EUR", wholesaleBaseUrl: "https://www.wetland.sk", adapterKey: "wetland" });
}

interface SeedProductOptions {
  readonly externalCode?: string | null;
  readonly name?: string;
}

async function seedProduct(db: Database, key: string, opts: SeedProductOptions = {}): Promise<void> {
  const snapshotId = await insertTestSnapshot(db);
  const name = opts.name ?? `Bunda ${key}`;
  await db.insert(products).values({
    key,
    name,
    supplier: "WETLAND",
    internalNote: null,
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
    name,
    currency: "EUR",
    price: "10.00",
    stock: 5,
    availabilityInStockText: "Skladom",
    availabilityOutOfStockText: "Vypredané",
    availabilityText: "Skladom",
    productVisibility: "visible",
    state: "sellable",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    lastSeenSnapshotId: snapshotId,
    missingSince: null,
  });
}

function wetlandCard(name: string, href: string): string {
  return `<div class="product-miniature__title"><a class="link" href="${href}">${name}</a></div>`;
}

/** Detailná stránka kandidáta — presne `.detail__title`="Kód" ->
 *  `.detail__right` kaskáda z `verify.ts` (mirror `wetland-detail-
 *  nohavice.html` fixtúry). */
function wetlandDetailPage(code: string | null): string {
  const codeBlock =
    code === null
      ? ""
      : `<li class="detail"><div class="detail__left"><span class="detail__title">Kód</span></div><div class="detail__right"><span>${code}</span></div></li>`;
  return `<html><body><h1>Detail kandidáta</h1><ul class="product__details">${codeBlock}</ul></body></html>`;
}

/** Smeruje podľa URL: `vyhladavanie` -> search výsledky, inak (kandidátova
 *  detailná URL) -> zadaná detail stránka. Zaznamenáva KAŽDÉ volanie do
 *  `calls`, aby testy vedeli overiť, či k detail-page fetchu vôbec došlo
 *  (dispatch E4: "šetri requesty" pre low/none confidence aj pre produkt
 *  bez external kódu). */
function routingFetcher(searchHtml: string, detailHtml: string, calls: string[]): Fetcher {
  return (url) => {
    calls.push(url);
    return Promise.resolve(url.includes("vyhladavanie") ? searchHtml : detailHtml);
  };
}

describe("pairing-search: kódové overenie (issue 387 E4)", () => {
  it("vysoká istota (kódová zhoda) + kód sedí na detaile -> verdict ok, verdictCheckedAt = now", async () => {
    const db = await boot();
    await seedSupplier(db);
    await seedProduct(db, "P1", { name: "Nohavice X", externalCode: "KOD777" });

    const searchHtml = wetlandCard("Úplne iný text KOD777 model", "https://www.wetland.sk/p/kod");
    const calls: string[] = [];
    const client = new SearchClient({ fetcher: routingFetcher(searchHtml, wetlandDetailPage("KOD777"), calls) });

    await runPairingSearch({ db, now: NOW, searchClient: client });

    const [set] = await db.select().from(pairingCandidateSets).where(eq(pairingCandidateSets.productKey, "P1"));
    expect(set?.confidence).toBe("high");
    expect(set?.verdict).toBe("ok");
    expect(set?.verdictCheckedAt?.toISOString()).toBe(NOW.toISOString());
    expect(calls.some((url) => url === "https://www.wetland.sk/p/kod")).toBe(true);
  });

  it("vysoká istota, ale kód sa na DETAILNEJ stránke kandidáta nenašiel -> verdict unsure", async () => {
    const db = await boot();
    await seedSupplier(db);
    await seedProduct(db, "P1", { name: "Nohavice X", externalCode: "KOD777" });

    const searchHtml = wetlandCard("Úplne iný text KOD777 model", "https://www.wetland.sk/p/kod");
    const calls: string[] = [];
    // Detailná stránka nesie INÝ kód (napr. dodávateľ zmenil produkt medzi
    // gatherom a verify fetchom) — kandidát bol vybraný na search-výsledku,
    // ale skutočný detail ho nepotvrdí.
    const client = new SearchClient({ fetcher: routingFetcher(searchHtml, wetlandDetailPage("INY-KOD"), calls) });

    await runPairingSearch({ db, now: NOW, searchClient: client });

    const [set] = await db.select().from(pairingCandidateSets).where(eq(pairingCandidateSets.productKey, "P1"));
    expect(set?.confidence).toBe("high");
    expect(set?.verdict).toBe("unsure");
  });

  it("nízka istota (low, menová zhoda pod 80) -> verify sa VÔBEC nezavolá, žiadny detail-page fetch, verdict null", async () => {
    const db = await boot();
    await seedSupplier(db);
    await seedProduct(db, "P1", { name: "Bunda Wetland" });

    const searchHtml = wetlandCard("Úplne nesúvisiaci produkt XYZ", "https://www.wetland.sk/p/low");
    const calls: string[] = [];
    const client = new SearchClient({ fetcher: routingFetcher(searchHtml, wetlandDetailPage("HOCICO"), calls) });

    await runPairingSearch({ db, now: NOW, searchClient: client });

    const [set] = await db.select().from(pairingCandidateSets).where(eq(pairingCandidateSets.productKey, "P1"));
    expect(set?.confidence).toBe("low");
    expect(set?.verdict).toBeNull();
    expect(set?.verdictCheckedAt).toBeNull();
    expect(calls.some((url) => url === "https://www.wetland.sk/p/low")).toBe(false);
  });

  it("medium istota (menová zhoda), ale produkt BEZ external kódu -> verdict unsure BEZ akéhokoľvek detail-page fetchu", async () => {
    const db = await boot();
    await seedSupplier(db);
    await seedProduct(db, "P1", { name: "Bunda Wetland Super", externalCode: null });

    const searchHtml = wetlandCard("Bunda Wetland Super", "https://www.wetland.sk/p/medium");
    const calls: string[] = [];
    const client = new SearchClient({ fetcher: routingFetcher(searchHtml, wetlandDetailPage("HOCICO"), calls) });

    await runPairingSearch({ db, now: NOW, searchClient: client });

    const [set] = await db.select().from(pairingCandidateSets).where(eq(pairingCandidateSets.productKey, "P1"));
    expect(set?.confidence).toBe("medium");
    expect(set?.verdict).toBe("unsure");
    // `verifyCandidateCode` sa krátko spojí PRED sieťou (`product.
    // externalCodes.length === 0`) — žiadne ĎALŠIE volanie na
    // "/p/medium" nad rámec search dopytov.
    expect(calls.some((url) => url === "https://www.wetland.sk/p/medium")).toBe(false);
  });
});
