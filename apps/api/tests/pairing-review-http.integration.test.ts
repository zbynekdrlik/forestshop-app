import { afterEach, expect, it } from "vitest";
import { productSupplierLinkOverrides, shopProductUrl, suppliers, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";
// issue 387 E6: `seedProduct`/`seedCandidateSet` vyčlenené do zdieľaného
// helpera (`helpers/pairing-review.ts`), aby ich vedel použiť aj nový
// `pairing-review-decisions-http.integration.test.ts` bez duplikácie.
import { seedPairingCandidateSet as seedCandidateSet, seedPairingReviewProduct as seedProduct } from "./helpers/pairing-review.js";

// issue 387 E5: "Eshop → Párovanie" — LEN čítanie (`GET /api/pairing-review`).
// Rozhodnutia (E6) tu ešte neexistujú.

const HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot(role: UserRole) {
  const ctx = await withCleanDb();
  close = ctx.close;
  const [pouzivatel] = await ctx.db
    .insert(users)
    .values({ email: "manazer@forestshop.sk", passwordHash: await hashPassword(HESLO), displayName: "Manažér", role })
    .returning({ id: users.id });
  if (pouzivatel === undefined) throw new Error("testovací používateľ sa nepodarilo vložiť");

  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db };
}

interface Telo {
  readonly total: number;
  readonly gatheredTotal: number;
  readonly linkedTotal: number;
  readonly items: {
    readonly productKey: string;
    readonly productName: string;
    readonly supplier: string | null;
    readonly externalCodes: string[];
    readonly variantCount: number;
    readonly productState: "sellable" | "out_of_stock" | "discontinued";
    readonly priceMin: string | null;
    readonly priceMax: string | null;
    readonly standardPriceMin: string | null;
    readonly standardPriceMax: string | null;
    readonly stockTotal: number;
    readonly availabilityText: string | null;
    readonly ourUrl: string;
    readonly ourUrlIsSearchFallback: boolean;
    readonly ourImageUrl: string | null;
    readonly hasEffectiveLink: boolean;
    readonly supplierHasAdapter: boolean;
    readonly gatheredAt: string | null;
    readonly confidence: "high" | "medium" | "low" | "none";
    readonly verdict: "ok" | "unsure" | null;
    readonly chosenCandidate: {
      readonly name: string;
      readonly url: string;
      readonly imageUrl: string | null;
      readonly rawScore: number;
      readonly codeHit: boolean;
    } | null;
  }[];
}

it("bez prihlásenia vráti 401", async () => {
  const { app } = await boot("manazer");
  expect((await app.request("/api/pairing-review")).status).toBe(401);
});

// issue 401 — populácia je teraz ÚNIA (gatherované ∪ bez efektívnej linky ∪
// rozhodnuté), nie len INNER JOIN na `pairing_candidate_set` (E5's pôvodná
// hranica). Produkt bez gather riadku, ale AJ BEZ efektívnej linky (typicky
// dodávateľ bez adaptéra — tu žiadny `suppliers` riadok vôbec neexistuje) sa
// TERAZ zobrazí, s `gatheredAt: null` a `supplierHasAdapter: false`.
it("issue 401: produkt BEZ pairing_candidate_set riadku A BEZ efektívnej linky SA ZOBRAZÍ (dodávateľ bez adaptéra) — plná populácia", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-NEGATHER", { name: "Negatherovaný produkt", supplier: "DODAVATEL-BEZ-ADAPTERA" });

  const telo = (await (await app.request("/api/pairing-review?filter=all", { headers: { cookie } })).json()) as Telo;
  const item = telo.items.find((i) => i.productKey === "PR-NEGATHER");
  expect(item).toBeDefined();
  expect(item?.gatheredAt).toBeNull();
  expect(item?.supplierHasAdapter).toBe(false);
  expect(item?.chosenCandidate).toBeNull();
  expect(item?.confidence).toBe("none");
  expect(telo.gatheredTotal).toBe(1);

  // "unreviewed" (bez efektívnej linky, bez terminálneho rozhodnutia) ho tiež zahŕňa.
  const unreviewedTelo = (await (await app.request("/api/pairing-review?filter=unreviewed", { headers: { cookie } })).json()) as Telo;
  expect(unreviewedTelo.items.some((i) => i.productKey === "PR-NEGATHER")).toBe(true);
});

// Prevrátený prípad — produkt BEZ gather riadku, ktorý UŽ MÁ efektívnu linku
// (napr. založenú cez #239/#240 predtým, než sem raz zavítal gather) sa
// NEZOBRAZÍ — netreba naň upozorňovať (rovnaká "má odkaz, netreba upozorniť"
// zásada ako E6's `unreviewed` predikát).
it("issue 401: produkt BEZ pairing_candidate_set riadku, ktorý UŽ MÁ efektívnu linku (mimo tejto obrazovky), sa NEZOBRAZÍ", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-LINKED-NOGATHER", { name: "Produkt s linkou bez gatheru", internalNote: "https://dodavatel.example.com/uz-ma-linku" });

  const telo = (await (await app.request("/api/pairing-review?filter=all", { headers: { cookie } })).json()) as Telo;
  expect(telo.items.some((i) => i.productKey === "PR-LINKED-NOGATHER")).toBe(false);
  expect(telo.gatheredTotal).toBe(0);
});

// issue 401 — `supplierHasAdapter` je `true` PRIAMO pre dodávateľa s
// registrovaným `suppliers.adapter_key`, nezávisle od toho, či preň gather
// UŽ prebehol (rovnaká `suppliers` tabuľka ako `pairing-search/select.ts`).
it("issue 401: supplierHasAdapter je true pre dodávateľa s registrovaným adaptérom, aj keď preň gather ešte nebehal", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await db.insert(suppliers).values({ name: "WETLAND", currency: "EUR", wholesaleBaseUrl: "https://www.wetland.sk", adapterKey: "wetland" });
  await seedProduct(db, snapshotId, "PR-ADAPTER-NEGATHER", { name: "Adaptérový, ešte negatherovaný", supplier: "WETLAND" });

  const telo = (await (await app.request("/api/pairing-review?filter=all", { headers: { cookie } })).json()) as Telo;
  const item = telo.items.find((i) => i.productKey === "PR-ADAPTER-NEGATHER");
  expect(item?.supplierHasAdapter).toBe(true);
  expect(item?.gatheredAt).toBeNull();
});

it("napárovaný produkt (chosenUrl) nesie navrhnutého kandidáta so skóre/istotou/kódovým overením", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-MATCHED", {
    name: "Bunda Alfa Zimná",
    supplier: "DODAVATEL-PR",
    variants: [{ code: "PR-MATCHED/1", externalCode: "KOD-123" }],
  });
  await seedCandidateSet(db, "PR-MATCHED", {
    chosenUrl: "https://dodavatel.example.com/bunda-alfa",
    confidence: "high",
    verdict: "ok",
    candidates: [
      {
        url: "https://dodavatel.example.com/bunda-alfa",
        name: "Bunda Alfa",
        rawScore: "1080.5000",
        codeHit: true,
        imageUrl: "https://dodavatel.example.com/img/bunda-alfa.jpg",
      },
    ],
  });

  const telo = (await (await app.request("/api/pairing-review?filter=matched", { headers: { cookie } })).json()) as Telo;
  const item = telo.items.find((i) => i.productKey === "PR-MATCHED");
  expect(item).toBeDefined();
  expect(item?.confidence).toBe("high");
  expect(item?.verdict).toBe("ok");
  expect(item?.chosenCandidate).toMatchObject({
    name: "Bunda Alfa",
    url: "https://dodavatel.example.com/bunda-alfa",
    imageUrl: "https://dodavatel.example.com/img/bunda-alfa.jpg",
    rawScore: 1080.5,
    codeHit: true,
  });
});

it("nenapárovaný produkt (confidence none, žiadny kandidát) má chosenCandidate null a padne do filtra 'unmatched'", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-UNMATCHED", { name: "Produkt bez kandidáta u dodávateľa" });
  await seedCandidateSet(db, "PR-UNMATCHED", { confidence: "none" });

  const telo = (await (await app.request("/api/pairing-review?filter=unmatched", { headers: { cookie } })).json()) as Telo;
  const item = telo.items.find((i) => i.productKey === "PR-UNMATCHED");
  expect(item?.chosenCandidate).toBeNull();
  expect(item?.confidence).toBe("none");

  const matchedTelo = (await (await app.request("/api/pairing-review?filter=matched", { headers: { cookie } })).json()) as Telo;
  expect(matchedTelo.items.some((i) => i.productKey === "PR-UNMATCHED")).toBe(false);
});

// "unreviewed" (default) = gather populácia BEZ efektívnej dodávateľskej
// linky — design komentár na tickete (issue 387 E5), nie "bez rozhodnutia"
// (pairing_decision tu ešte neexistuje, E6).
it("'unreviewed' = produkt z gather populácie BEZ efektívnej linky — produkt S linkou (internalNote) v ňom NIE JE", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-BEZLINKY", { name: "Produkt bez linky" });
  await seedCandidateSet(db, "PR-BEZLINKY", { confidence: "none" });
  await seedProduct(db, snapshotId, "PR-SLINKOU", {
    name: "Produkt s linkou",
    internalNote: "https://dodavatel.example.com/uz-ma-linku",
  });
  await seedCandidateSet(db, "PR-SLINKOU", { confidence: "none" });

  const telo = (await (await app.request("/api/pairing-review?filter=unreviewed", { headers: { cookie } })).json()) as Telo;
  expect(telo.items.some((i) => i.productKey === "PR-BEZLINKY")).toBe(true);
  expect(telo.items.some((i) => i.productKey === "PR-SLINKOU")).toBe(false);
  // gatheredTotal/linkedTotal sa počítajú nad CELOU gather populáciou,
  // nezávisle od `filter` — progress bar/badge na tomto stoja.
  expect(telo.gatheredTotal).toBe(2);
  expect(telo.linkedTotal).toBe(1);
});

it("efektívna linka LEN z override (bez internalNote) tiež vyradí produkt z 'unreviewed'", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-OVERRIDE", { name: "Produkt s override linkou" });
  await seedCandidateSet(db, "PR-OVERRIDE", { confidence: "none" });
  await db.insert(productSupplierLinkOverrides).values({ productKey: "PR-OVERRIDE", url: "https://dodavatel.example.com/z-override", updatedAt: new Date() });

  const telo = (await (await app.request("/api/pairing-review?filter=unreviewed", { headers: { cookie } })).json()) as Telo;
  expect(telo.items.some((i) => i.productKey === "PR-OVERRIDE")).toBe(false);
});

it("rollup stavu produktu: nejaký sellable variant → st1 (Skladom)", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-ST1", {
    name: "Produkt Skladom",
    variants: [
      { code: "PR-ST1/1", state: "out_of_stock" },
      { code: "PR-ST1/2", state: "sellable" },
    ],
  });
  await seedCandidateSet(db, "PR-ST1");

  const telo = (await (await app.request("/api/pairing-review?filter=st1", { headers: { cookie } })).json()) as Telo;
  expect(telo.items.map((i) => i.productKey)).toContain("PR-ST1");
  expect(telo.items.find((i) => i.productKey === "PR-ST1")?.productState).toBe("sellable");
});

it("rollup stavu produktu: žiadny sellable, ale out_of_stock+viditeľný → st2 (Nie je skladom)", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-ST2", { name: "Produkt vypredaný", variants: [{ code: "PR-ST2/1", state: "out_of_stock" }] });
  await seedCandidateSet(db, "PR-ST2");

  const telo = (await (await app.request("/api/pairing-review?filter=st2", { headers: { cookie } })).json()) as Telo;
  expect(telo.items.find((i) => i.productKey === "PR-ST2")?.productState).toBe("out_of_stock");
});

// `detailOnly`/skryté out_of_stock samo osebe NIE JE "Nie je skladom" —
// `.claude/rules/catalog.md`'s availability.ts pravidlo, rollup padá na st3.
it("rollup stavu produktu: out_of_stock ale SKRYTÝ (nie 'visible') → st3 (Už sa nebude predávať), nikdy st2", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-ST3", {
    name: "Produkt ukončený predaj",
    variants: [{ code: "PR-ST3/1", state: "out_of_stock", productVisibility: "detailOnly" }],
  });
  await seedCandidateSet(db, "PR-ST3");

  const telo = (await (await app.request("/api/pairing-review?filter=st3", { headers: { cookie } })).json()) as Telo;
  expect(telo.items.find((i) => i.productKey === "PR-ST3")?.productState).toBe("discontinued");
  const st2 = (await (await app.request("/api/pairing-review?filter=st2", { headers: { cookie } })).json()) as Telo;
  expect(st2.items.some((i) => i.productKey === "PR-ST3")).toBe(false);
});

it("naša URL/obrázok prichádza zo shop_product_url zhody podľa kódu variantu, inak padá na vyhľadávací fallback", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-FEED", { name: "Produkt s feedom", variants: [{ code: "PR-FEED/1" }] });
  await db.insert(shopProductUrl).values({ code: "PR-FEED/1", url: "https://www.forestshop.sk/produkt-s-feedom", imageUrl: "https://www.forestshop.sk/img/x.jpg", fetchedAt: new Date() });
  await seedCandidateSet(db, "PR-FEED");

  await seedProduct(db, snapshotId, "PR-NOFEED", { name: "Produkt Bez Feedu", variants: [{ code: "PR-NOFEED/1" }] });
  await seedCandidateSet(db, "PR-NOFEED");

  const telo = (await (await app.request("/api/pairing-review?filter=all", { headers: { cookie } })).json()) as Telo;
  const withFeed = telo.items.find((i) => i.productKey === "PR-FEED");
  expect(withFeed?.ourUrl).toBe("https://www.forestshop.sk/produkt-s-feedom");
  expect(withFeed?.ourUrlIsSearchFallback).toBe(false);
  expect(withFeed?.ourImageUrl).toBe("https://www.forestshop.sk/img/x.jpg");

  const withoutFeed = telo.items.find((i) => i.productKey === "PR-NOFEED");
  expect(withoutFeed?.ourUrl).toBe("https://www.forestshop.sk/vyhladavanie/?string=" + encodeURIComponent("Produkt Bez Feedu"));
  // issue 402: fallback bez akéhokoľvek shop_product_url riadku sa MUSÍ dať
  // rozlíšiť od priameho odkazu — karta ho vizuálne odlíši práve podľa tohto poľa.
  expect(withoutFeed?.ourUrlIsSearchFallback).toBe(true);
  expect(withoutFeed?.ourImageUrl).toBeNull();
});

// Unmatched-last (design komentár, zadanie E5 bod 3) — napárované PRED
// nenapárovanými, sekundárne meno (sk locale).
it("triedenie: napárované PRED nenapárovanými (unmatched-last), sekundárne podľa mena", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-RAD-Z", { name: "Z produkt nenapárovaný" });
  await seedCandidateSet(db, "PR-RAD-Z", { confidence: "none" });
  await seedProduct(db, snapshotId, "PR-RAD-B", { name: "B produkt napárovaný" });
  await seedCandidateSet(db, "PR-RAD-B", { chosenUrl: "https://dodavatel.example.com/b", candidates: [{ url: "https://dodavatel.example.com/b", name: "B", rawScore: "80.0000", codeHit: false }] });
  await seedProduct(db, snapshotId, "PR-RAD-A", { name: "A produkt napárovaný" });
  await seedCandidateSet(db, "PR-RAD-A", { chosenUrl: "https://dodavatel.example.com/a", candidates: [{ url: "https://dodavatel.example.com/a", name: "A", rawScore: "80.0000", codeHit: false }] });

  const telo = (await (await app.request("/api/pairing-review?filter=all&pageSize=10", { headers: { cookie } })).json()) as Telo;
  const order = telo.items.map((i) => i.productKey).filter((k) => k.startsWith("PR-RAD-"));
  expect(order).toEqual(["PR-RAD-A", "PR-RAD-B", "PR-RAD-Z"]);
});

// issue 331's precedens: `total`/`gatheredTotal`/`linkedTotal` sa počítajú
// nad CELOU (odfiltrovanou/celkovou) množinou nezávisle od `pageSize` —
// badge v menu na tomto stojí.
it("total/gatheredTotal/linkedTotal sa počítajú nezávisle od pageSize", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-BADGE-1", { name: "Bez linky Prvý" });
  await seedCandidateSet(db, "PR-BADGE-1", { confidence: "none" });
  await seedProduct(db, snapshotId, "PR-BADGE-2", { name: "Bez linky Druhý" });
  await seedCandidateSet(db, "PR-BADGE-2", { confidence: "none" });

  const telo = (await (await app.request("/api/pairing-review?filter=unreviewed&page=1&pageSize=1", { headers: { cookie } })).json()) as Telo;
  expect(telo.total).toBe(2);
  expect(telo.items).toHaveLength(1);
});

// issue 422 — "naša strana": pôvodná (pred zľavou) cena, súčet zásoby,
// dostupnostný text — rozšírenie `PairingReviewItem` o persistované polia
// (žiadny live-fetch).
it("issue 422: standardPriceMin/Max, stockTotal, availabilityText — jednoveľkostný produkt s pôvodnou cenou a skladom", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-CENA-1", {
    name: "Produkt so zľavou",
    variants: [{ code: "PR-CENA-1/1", price: "49.90", standardPrice: "59.90", stock: 3, availabilityText: "Skladom" }],
  });
  await seedCandidateSet(db, "PR-CENA-1");

  const telo = (await (await app.request("/api/pairing-review?filter=all", { headers: { cookie } })).json()) as Telo;
  const item = telo.items.find((i) => i.productKey === "PR-CENA-1");
  expect(item?.priceMin).toBe("49.90");
  expect(item?.standardPriceMin).toBe("59.90");
  expect(item?.standardPriceMax).toBe("59.90");
  expect(item?.stockTotal).toBe(3);
  expect(item?.availabilityText).toBe("Skladom");
});

it("issue 422: viacveľkostný produkt — standardPrice/stock/availabilityText sa agregujú naprieč variantmi (min/max/súčet/distinct join)", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-CENA-2", {
    name: "Produkt viac veľkostí",
    variants: [
      { code: "PR-CENA-2/S", price: "10.00", standardPrice: "12.00", stock: 2, availabilityText: "Skladom" },
      { code: "PR-CENA-2/M", price: "10.00", standardPrice: "15.00", stock: 5, availabilityText: "Posledný kus" },
    ],
  });
  await seedCandidateSet(db, "PR-CENA-2");

  const telo = (await (await app.request("/api/pairing-review?filter=all", { headers: { cookie } })).json()) as Telo;
  const item = telo.items.find((i) => i.productKey === "PR-CENA-2");
  expect(item?.standardPriceMin).toBe("12.00");
  expect(item?.standardPriceMax).toBe("15.00");
  expect(item?.stockTotal).toBe(7);
  expect(item?.availabilityText).toBe("Skladom / Posledný kus");
});

it("issue 422: bez pôvodnej ceny/zásoby/textu — všetky tri polia sú null/0/null, nikdy nevyhodí", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-CENA-PRAZDNY", {
    name: "Produkt bez cenových dát",
    variants: [{ code: "PR-CENA-PRAZDNY/1", availabilityText: "" }],
  });
  await seedCandidateSet(db, "PR-CENA-PRAZDNY");

  const telo = (await (await app.request("/api/pairing-review?filter=all", { headers: { cookie } })).json()) as Telo;
  const item = telo.items.find((i) => i.productKey === "PR-CENA-PRAZDNY");
  expect(item?.standardPriceMin).toBeNull();
  expect(item?.standardPriceMax).toBeNull();
  expect(item?.stockTotal).toBe(0);
  expect(item?.availabilityText).toBeNull();
});
