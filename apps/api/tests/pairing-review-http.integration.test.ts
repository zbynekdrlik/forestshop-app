import { afterEach, expect, it } from "vitest";
import type { Database } from "../src/db/client.js";
import {
  pairingCandidates,
  pairingCandidateSets,
  productSupplierLinkOverrides,
  products,
  shopProductUrl,
  users,
  variants,
} from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";

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
    readonly ourUrl: string;
    readonly ourImageUrl: string | null;
    readonly hasEffectiveLink: boolean;
    readonly confidence: "high" | "medium" | "low" | "none";
    readonly verdict: "ok" | "unsure" | null;
    readonly chosenCandidate: { readonly name: string; readonly url: string; readonly rawScore: number; readonly codeHit: boolean } | null;
  }[];
}

async function seedProduct(
  db: Database,
  snapshotId: string,
  productKey: string,
  over: {
    readonly name: string;
    readonly supplier?: string | null;
    readonly internalNote?: string | null;
    readonly variants?: readonly {
      readonly code: string;
      readonly externalCode?: string | null;
      readonly state?: "sellable" | "out_of_stock" | "discontinued";
      readonly productVisibility?: string;
      readonly missingSince?: Date | null;
      readonly price?: string | null;
    }[];
  },
): Promise<void> {
  const now = new Date("2026-08-13T00:00:00Z");
  await db.insert(products).values({
    key: productKey,
    name: over.name,
    supplier: over.supplier ?? null,
    internalNote: over.internalNote ?? null,
    firstSeenAt: now,
    lastSeenAt: now,
    lastSeenSnapshotId: snapshotId,
  });
  const variantSpecs = over.variants ?? [{ code: `${productKey}/1` }];
  for (const v of variantSpecs) {
    await db.insert(variants).values({
      code: v.code,
      productKey,
      guid: productKey,
      externalCode: v.externalCode ?? null,
      name: over.name,
      price: v.price ?? null,
      stock: 0,
      availabilityInStockText: "Skladom",
      availabilityOutOfStockText: "Vypredané",
      availabilityText: v.state === "out_of_stock" ? "Vypredané" : "Skladom",
      productVisibility: v.productVisibility ?? "visible",
      state: v.state ?? "sellable",
      missingSince: v.missingSince ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
      lastSeenSnapshotId: snapshotId,
    });
  }
}

async function seedCandidateSet(
  db: Database,
  productKey: string,
  over: {
    readonly chosenUrl?: string | null;
    readonly confidence?: "high" | "medium" | "low" | "none";
    readonly verdict?: "ok" | "unsure" | null;
    readonly candidates?: readonly { readonly url: string; readonly name: string; readonly rawScore: string; readonly codeHit: boolean }[];
  } = {},
): Promise<void> {
  await db.insert(pairingCandidateSets).values({
    productKey,
    gatheredAt: new Date("2026-08-13T03:35:00Z"),
    queries: ["dopyt"],
    inputHash: "hash-" + productKey,
    chosenUrl: over.chosenUrl ?? null,
    chosenReason: over.chosenUrl !== undefined && over.chosenUrl !== null ? "najlepší nájdený" : null,
    confidence: over.confidence ?? (over.chosenUrl !== undefined && over.chosenUrl !== null ? "medium" : "none"),
    verdict: over.verdict ?? null,
    verdictCheckedAt: over.verdict !== undefined && over.verdict !== null ? new Date("2026-08-13T03:36:00Z") : null,
  });
  for (const [i, c] of (over.candidates ?? []).entries()) {
    await db.insert(pairingCandidates).values({
      productKey,
      position: i,
      name: c.name,
      url: c.url,
      rawScore: c.rawScore,
      codeHit: c.codeHit,
    });
  }
}

it("bez prihlásenia vráti 401", async () => {
  const { app } = await boot("manazer");
  expect((await app.request("/api/pairing-review")).status).toBe(401);
});

it("produkt BEZ pairing_candidate_set riadku (gather ho ešte nespracoval) sa v zozname vôbec nezobrazí", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-NEGATHER", { name: "Negatherovaný produkt" });

  const telo = (await (await app.request("/api/pairing-review?filter=all", { headers: { cookie } })).json()) as Telo;
  expect(telo.items.some((i) => i.productKey === "PR-NEGATHER")).toBe(false);
  expect(telo.gatheredTotal).toBe(0);
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
    candidates: [{ url: "https://dodavatel.example.com/bunda-alfa", name: "Bunda Alfa", rawScore: "1080.5000", codeHit: true }],
  });

  const telo = (await (await app.request("/api/pairing-review?filter=matched", { headers: { cookie } })).json()) as Telo;
  const item = telo.items.find((i) => i.productKey === "PR-MATCHED");
  expect(item).toBeDefined();
  expect(item?.confidence).toBe("high");
  expect(item?.verdict).toBe("ok");
  expect(item?.chosenCandidate).toMatchObject({ name: "Bunda Alfa", url: "https://dodavatel.example.com/bunda-alfa", rawScore: 1080.5, codeHit: true });
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
  expect(withFeed?.ourImageUrl).toBe("https://www.forestshop.sk/img/x.jpg");

  const withoutFeed = telo.items.find((i) => i.productKey === "PR-NOFEED");
  expect(withoutFeed?.ourUrl).toBe("https://www.forestshop.sk/vyhladavanie/?string=" + encodeURIComponent("Produkt Bez Feedu"));
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
