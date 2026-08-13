// issue 397 — backfill obrázka CHOSEN kandidáta pre existujúcich `pairing_
// candidate` riadkov bez neho. Design komentár na tickete ("Zvolený prístup
// — existujúcich 1309 kandidátov bez obrázka"): cielený backfill (JEDEN
// fetch na produkt), nikdy `input_hash` bump/plný re-gather.

import { eq } from "drizzle-orm";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import { pairingCandidates } from "../src/db/schema.js";
import { SearchClient, type Fetcher } from "../src/modules/pairing-search/client.js";
import { backfillCandidateImages } from "../src/modules/pairing-search/backfill.js";
import { PAIRING_SEARCH_RUN_LOCK_KEY } from "../src/modules/pairing-search/constants.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";
import { seedPairingCandidateSet as seedCandidateSet, seedPairingReviewProduct as seedProduct } from "./helpers/pairing-review.js";

let close: (() => Promise<void>) | undefined;
let lockHolder: pg.Client | undefined;

afterEach(async () => {
  if (lockHolder !== undefined) {
    await lockHolder.query("select pg_advisory_unlock($1)", [PAIRING_SEARCH_RUN_LOCK_KEY]);
    await lockHolder.end();
    lockHolder = undefined;
  }
  await close?.();
  close = undefined;
});

async function boot(): Promise<Database> {
  const ctx = await withCleanDb();
  close = ctx.close;
  return ctx.db;
}

function ogImageHtml(imageUrl: string): string {
  return `<html><head><meta property="og:image" content="${imageUrl}"></head><body></body></html>`;
}

describe("backfillCandidateImages (issue 397)", () => {
  it("backfills the CHOSEN candidate's image from og:image, leaves other top-8 rows untouched", async () => {
    const db = await boot();
    const snapshotId = await insertTestSnapshot(db);
    await seedProduct(db, snapshotId, "P1", { name: "Bunda P1" });
    await seedCandidateSet(db, "P1", {
      chosenUrl: "https://dodavatel.example.com/chosen",
      confidence: "high",
      candidates: [
        { url: "https://dodavatel.example.com/chosen", name: "Chosen", rawScore: "1050.0000", codeHit: true },
        { url: "https://dodavatel.example.com/other", name: "Other (nie chosen)", rawScore: "60.0000", codeHit: false },
      ],
    });

    let calls = 0;
    const fetcher: Fetcher = (url) => {
      calls += 1;
      expect(url).toBe("https://dodavatel.example.com/chosen"); // NIKDY non-chosen top-8 riadok
      return Promise.resolve(ogImageHtml("https://dodavatel.example.com/img/chosen.jpg"));
    };
    const searchClient = new SearchClient({ fetcher });

    const result = await backfillCandidateImages({ db, searchClient });

    expect(result).toMatchObject({ checked: 1, updated: 1, failed: 0 });
    expect(calls).toBe(1);

    const rows = await db.select().from(pairingCandidates).where(eq(pairingCandidates.productKey, "P1"));
    expect(rows.find((r) => r.url === "https://dodavatel.example.com/chosen")?.imageUrl).toBe(
      "https://dodavatel.example.com/img/chosen.jpg",
    );
    expect(rows.find((r) => r.url === "https://dodavatel.example.com/other")?.imageUrl).toBeNull();
  });

  it("skips a candidate that ALREADY has an image (adaptér ho už našiel pri gathere)", async () => {
    const db = await boot();
    const snapshotId = await insertTestSnapshot(db);
    await seedProduct(db, snapshotId, "P1", { name: "Bunda P1" });
    await seedCandidateSet(db, "P1", {
      chosenUrl: "https://dodavatel.example.com/chosen",
      candidates: [
        {
          url: "https://dodavatel.example.com/chosen",
          name: "Chosen",
          rawScore: "1050.0000",
          codeHit: true,
          imageUrl: "https://dodavatel.example.com/uz-mam-obrazok.jpg",
        },
      ],
    });

    let called = false;
    const fetcher: Fetcher = () => {
      called = true;
      return Promise.resolve(ogImageHtml("https://dodavatel.example.com/nikdy-pouzity.jpg"));
    };
    const result = await backfillCandidateImages({ db, searchClient: new SearchClient({ fetcher }) });

    expect(result).toMatchObject({ checked: 0, updated: 0, failed: 0 });
    expect(called).toBe(false);

    const [row] = await db.select().from(pairingCandidates).where(eq(pairingCandidates.url, "https://dodavatel.example.com/chosen"));
    expect(row?.imageUrl).toBe("https://dodavatel.example.com/uz-mam-obrazok.jpg");
  });

  it("stránka bez použiteľného og:image (šumový/chýbajúci) sa NEPOČÍTA ako chyba, len ostáva null", async () => {
    const db = await boot();
    const snapshotId = await insertTestSnapshot(db);
    await seedProduct(db, snapshotId, "P1", { name: "Bunda P1" });
    await seedCandidateSet(db, "P1", {
      chosenUrl: "https://dodavatel.example.com/chosen",
      candidates: [{ url: "https://dodavatel.example.com/chosen", name: "Chosen", rawScore: "1050.0000", codeHit: true }],
    });

    const fetcher: Fetcher = () => Promise.resolve("<html><head></head><body>bez og:image</body></html>");
    const result = await backfillCandidateImages({ db, searchClient: new SearchClient({ fetcher }) });

    expect(result).toMatchObject({ checked: 1, updated: 0, failed: 0 });
    const [row] = await db.select().from(pairingCandidates).where(eq(pairingCandidates.url, "https://dodavatel.example.com/chosen"));
    expect(row?.imageUrl).toBeNull();
  });

  it("zlyhaný fetch pre JEDEN produkt sa zaloguje do errors a POKRAČUJE ďalším produktom", async () => {
    const db = await boot();
    const snapshot1 = await insertTestSnapshot(db);
    await seedProduct(db, snapshot1, "FAIL", { name: "Bunda FAIL" });
    await seedCandidateSet(db, "FAIL", {
      chosenUrl: "https://dodavatel.example.com/fail",
      candidates: [{ url: "https://dodavatel.example.com/fail", name: "Fail", rawScore: "1050.0000", codeHit: true }],
    });
    const snapshot2 = await insertTestSnapshot(db);
    await seedProduct(db, snapshot2, "OK", { name: "Bunda OK" });
    await seedCandidateSet(db, "OK", {
      chosenUrl: "https://dodavatel.example.com/ok",
      candidates: [{ url: "https://dodavatel.example.com/ok", name: "OK", rawScore: "1050.0000", codeHit: true }],
    });

    const fetcher: Fetcher = (url) => {
      if (url.includes("fail")) return Promise.reject(new Error("simulovaný sieťový pád"));
      return Promise.resolve(ogImageHtml("https://dodavatel.example.com/img/ok.jpg"));
    };
    const result = await backfillCandidateImages({ db, searchClient: new SearchClient({ fetcher }) });

    expect(result).toMatchObject({ checked: 2, updated: 1, failed: 1 });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.productKey).toBe("FAIL");
    expect(result.errors[0]?.message).toContain("simulovaný sieťový pád");

    const [okRow] = await db.select().from(pairingCandidates).where(eq(pairingCandidates.url, "https://dodavatel.example.com/ok"));
    expect(okRow?.imageUrl).toBe("https://dodavatel.example.com/img/ok.jpg");
  });

  it("idempotentný: druhý beh po úspešnom prvom nenájde už nič na doplnenie", async () => {
    const db = await boot();
    const snapshotId = await insertTestSnapshot(db);
    await seedProduct(db, snapshotId, "P1", { name: "Bunda P1" });
    await seedCandidateSet(db, "P1", {
      chosenUrl: "https://dodavatel.example.com/chosen",
      candidates: [{ url: "https://dodavatel.example.com/chosen", name: "Chosen", rawScore: "1050.0000", codeHit: true }],
    });

    let calls = 0;
    const fetcher: Fetcher = () => {
      calls += 1;
      return Promise.resolve(ogImageHtml("https://dodavatel.example.com/img/x.jpg"));
    };
    const searchClient = new SearchClient({ fetcher });

    const first = await backfillCandidateImages({ db, searchClient });
    expect(first).toMatchObject({ checked: 1, updated: 1 });
    expect(calls).toBe(1);

    const second = await backfillCandidateImages({ db, searchClient });
    expect(second).toMatchObject({ checked: 0, updated: 0, failed: 0 });
    expect(calls).toBe(1); // žiadny ďalší fetch
  });

  // Review nález (issue 397): predošlá verzia tohto testu nesedela s ničím
  // — `seedCandidateSet(db, "P1", { confidence: "none" })` vloží NULU
  // `pairing_candidate` riadkov (`helpers/pairing-review.ts`'s `(over.
  // candidates ?? [])`), takže `checked: 0` by platilo aj keby `innerJoin`
  // bol `leftJoin`, alebo keby `eq(chosenUrl, url)` podmienka vôbec
  // chýbala. TERAZ produkt SKUTOČNE nesie top-8 kandidátov (žiadny z nich
  // `chosenUrl`, ktorý je `null`) — dokazuje, že `eq(pairingCandidateSets
  // .chosenUrl, pairingCandidates.url)` proti `NULL` skutočne nikdy
  // nezhodí ŽIADEN riadok (SQL `NULL = 'x'` je `NULL`, nikdy `true`).
  it("produkt BEZ chosen_url (confidence none), ale S top-8 kandidátmi, sa nikdy nezoberie do backfillu", async () => {
    const db = await boot();
    const snapshotId = await insertTestSnapshot(db);
    await seedProduct(db, snapshotId, "P1", { name: "Bunda P1" });
    await seedCandidateSet(db, "P1", {
      chosenUrl: null,
      confidence: "none",
      candidates: [{ url: "https://dodavatel.example.com/nechosen", name: "Nikdy chosen", rawScore: "10.0000", codeHit: false }],
    });

    let called = false;
    const fetcher: Fetcher = () => {
      called = true;
      return Promise.resolve(ogImageHtml("https://x/never.jpg"));
    };
    const result = await backfillCandidateImages({ db, searchClient: new SearchClient({ fetcher }) });

    expect(result).toMatchObject({ checked: 0, updated: 0, failed: 0 });
    expect(called).toBe(false);

    const [row] = await db.select().from(pairingCandidates).where(eq(pairingCandidates.url, "https://dodavatel.example.com/nechosen"));
    expect(row?.imageUrl).toBeNull(); // ostal nedotknutý, nikdy nebol ani "checked"
  });

  // Review nález (issue 397): oba guardy v `applyImageFallback` (run.ts) —
  // "nikdy neprepíš existujúci adaptérov obrázok" a "dotkni sa LEN chosen
  // riadku" — sa dajú vymazať bez toho, aby padol JEDINÝ existujúci test.
  // Toto je zámerne backfillov EKVIVALENT tej istej dvojice invariantov:
  // backfill sa dotkne LEN riadkov s `image_url IS NULL` (`WHERE` klauzula,
  // nikdy "prepíš aj existujúci"), a LEN chosen riadku (`INNER JOIN` na
  // `chosenUrl = url`, nikdy iný top-8 riadok toho istého produktu).
  it("issue 397: druhý top-8 kandidát BEZ obrázka, ktorý NIE JE chosen, ostáva nedotknutý (backfill sa ho ani nepýta)", async () => {
    const db = await boot();
    const snapshotId = await insertTestSnapshot(db);
    await seedProduct(db, snapshotId, "P1", { name: "Bunda P1" });
    await seedCandidateSet(db, "P1", {
      chosenUrl: "https://dodavatel.example.com/chosen",
      candidates: [
        {
          url: "https://dodavatel.example.com/chosen",
          name: "Chosen",
          rawScore: "1050.0000",
          codeHit: true,
          imageUrl: "https://dodavatel.example.com/uz-mam-obrazok.jpg",
        },
        { url: "https://dodavatel.example.com/druhy-bez-obrazka", name: "Druhý (nie chosen, bez obrázka)", rawScore: "60.0000", codeHit: false },
      ],
    });

    let called = false;
    const fetcher: Fetcher = () => {
      called = true;
      return Promise.resolve(ogImageHtml("https://dodavatel.example.com/nikdy-pouzity.jpg"));
    };
    const result = await backfillCandidateImages({ db, searchClient: new SearchClient({ fetcher }) });

    // Chosen riadok je preskočený (už má obrázok), "druhý" riadok je
    // preskočený (nie je chosen) — spolu `checked: 0`, ŽIADEN fetch.
    expect(result).toMatchObject({ checked: 0, updated: 0, failed: 0 });
    expect(called).toBe(false);

    const [druhy] = await db.select().from(pairingCandidates).where(eq(pairingCandidates.url, "https://dodavatel.example.com/druhy-bez-obrazka"));
    expect(druhy?.imageUrl).toBeNull();
  });

  // Review nález (issue 397): per-host prehľad (`noImageFoundByHost`) —
  // operátor musí vedieť, KTORÝ host stránku stiahol, ale nedal žiadny
  // použiteľný obrázok (napr. BETALOV, kde detailná og:image je VŽDY
  // stránkové logo — šumový filter ho vyfiltruje na null KAŽDÝKRÁT).
  it("issue 397: per-host prehľad ráta riadky, kde sa stránka stiahla, ale og:image nebol použiteľný", async () => {
    const db = await boot();
    const snapshotId = await insertTestSnapshot(db);
    await seedProduct(db, snapshotId, "P1", { name: "Bunda P1", supplier: "BETALOV" });
    await seedCandidateSet(db, "P1", {
      chosenUrl: "https://www.huntingshop.eu/produkt-1",
      candidates: [{ url: "https://www.huntingshop.eu/produkt-1", name: "Produkt 1", rawScore: "1050.0000", codeHit: true }],
    });
    const snapshot2 = await insertTestSnapshot(db);
    await seedProduct(db, snapshot2, "P2", { name: "Bunda P2", supplier: "BETALOV" });
    await seedCandidateSet(db, "P2", {
      chosenUrl: "https://www.huntingshop.eu/produkt-2",
      candidates: [{ url: "https://www.huntingshop.eu/produkt-2", name: "Produkt 2", rawScore: "1050.0000", codeHit: true }],
    });

    // BETALOV's detail og:image je VŽDY stránkové logo (živo overené,
    // playbook) — `resolveImageUrl` ho vyfiltruje na null pre OBA riadky.
    const fetcher: Fetcher = () =>
      Promise.resolve('<html><head><meta property="og:image" content="https://www.huntingshop.eu/assets2/front/svg/logo2.svg"></head></html>');
    const result = await backfillCandidateImages({ db, searchClient: new SearchClient({ fetcher }) });

    expect(result).toMatchObject({ checked: 2, updated: 0, failed: 0 });
    expect(result.noImageFoundByHost).toEqual({ "www.huntingshop.eu": 2 });
  });

  // Review nález (issue 397): `pg_advisory_lock` (BLOKUJÚCI) by tu ticho
  // VISEL, kým `lockHolder` zámok nedrží — `pg_try_advisory_lock`
  // (NEBLOKUJÚCI) musí zlyhať NAHLAS a okamžite namiesto zaseknutia.
  it("issue 397: keď advisory zámok drží iné pripojenie (napr. nočný gather beh), backfill zlyhá NAHLAS namiesto ticheho zaseknutia", async () => {
    const db = await boot();
    const snapshotId = await insertTestSnapshot(db);
    await seedProduct(db, snapshotId, "P1", { name: "Bunda P1" });
    await seedCandidateSet(db, "P1", {
      chosenUrl: "https://dodavatel.example.com/chosen",
      candidates: [{ url: "https://dodavatel.example.com/chosen", name: "Chosen", rawScore: "1050.0000", codeHit: true }],
    });

    const databaseUrl = process.env["DATABASE_URL"];
    if (databaseUrl === undefined || databaseUrl === "") throw new Error("DATABASE_URL chýba");
    lockHolder = new pg.Client({ connectionString: databaseUrl });
    await lockHolder.connect();
    await lockHolder.query("select pg_advisory_lock($1)", [PAIRING_SEARCH_RUN_LOCK_KEY]);

    let called = false;
    const fetcher: Fetcher = () => {
      called = true;
      return Promise.resolve(ogImageHtml("https://nikdy-pouzity.example.com/x.jpg"));
    };

    await expect(backfillCandidateImages({ db, searchClient: new SearchClient({ fetcher }) })).rejects.toThrow(/advisory zámok/);
    expect(called).toBe(false);
  });
});
