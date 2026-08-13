import { afterEach, expect, it } from "vitest";
import { productSupplierLinkOverrides, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";
import { seedPairingCandidateSet as seedCandidateSet, seedPairingReviewProduct as seedProduct } from "./helpers/pairing-review.js";

// issue 399 — "Hľadať / opraviť" tab: `GET /api/pairing-review/:productKey`
// nájde/postaví kartu pre AKÝKOĽVEK produkt, NEZÁVISLE od `listPairingReview`'s
// populácie (design komentár na tickete, sekcia "Prístup 1"). Vyčlenené do
// vlastného súboru (rovnaký `.claude/rules/testing.md` split vzor ako
// `pairing-review-http.integration.test.ts`/`pairing-review-decisions-http
// .integration.test.ts`), aby ani jeden nenarástol cez eslint `max-lines: 400`.

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
  return { app, cookie, db: ctx.db, userId: pouzivatel.id };
}

it("bez prihlásenia vráti 401", async () => {
  const { app } = await boot("manazer");
  expect((await app.request("/api/pairing-review/X")).status).toBe(401);
});

it("neznámy productKey vráti 404", async () => {
  const { app, cookie } = await boot("citanie");
  const res = await app.request("/api/pairing-review/NEEXISTUJE", { headers: { cookie } });
  expect(res.status).toBe(404);
});

it("produkt VNÚTRI listPairingReview's populácie (bez linky, s kandidátom) — rovnaký tvar ako zoznamová položka", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-ITEM-1", { name: "Bunda Alfa" });
  await seedCandidateSet(db, "PR-ITEM-1", {
    chosenUrl: "https://dodavatel.example.com/bunda-alfa",
    candidates: [{ url: "https://dodavatel.example.com/bunda-alfa", name: "Bunda Alfa u dodávateľa", rawScore: "85.0000", codeHit: true }],
  });

  const res = await app.request("/api/pairing-review/PR-ITEM-1", { headers: { cookie } });
  expect(res.status).toBe(200);
  const telo = (await res.json()) as { readonly item: { readonly productKey: string; readonly productName: string; readonly chosenCandidate: { readonly name: string } | null } };
  expect(telo.item.productKey).toBe("PR-ITEM-1");
  expect(telo.item.productName).toBe("Bunda Alfa");
  expect(telo.item.chosenCandidate?.name).toBe("Bunda Alfa u dodávateľa");
});

// issue 399 — TOTO je presne dôvod, prečo tento endpoint existuje (design
// komentár, sekcia "Prístup 1"): produkt s efektívnou linkou z
// `internalNote`, ale BEZ `pairing_candidate_set`/`pairing_decision` riadku,
// NIE JE v `listPairingReview`'s populácii vôbec — `filter=all` ho nikdy
// nevráti, ale "Hľadať / opraviť" ho tu stále musí nájsť a otvoriť.
it("produkt MIMO listPairingReview's populácie (má efektívnu linku, žiadny candidate_set/decision) sa NÁJDE tu, hoci NIE JE v zozname", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-ITEM-MIMO", { name: "Produkt s vlastnou linkou", internalNote: "https://dodavatel.example.com/uz-mam-link" });

  const zoznam = (await (await app.request("/api/pairing-review?filter=all&pageSize=200", { headers: { cookie } })).json()) as {
    readonly items: { readonly productKey: string }[];
  };
  expect(zoznam.items.some((i) => i.productKey === "PR-ITEM-MIMO")).toBe(false);

  const res = await app.request("/api/pairing-review/PR-ITEM-MIMO", { headers: { cookie } });
  expect(res.status).toBe(200);
  const telo = (await res.json()) as { readonly item: { readonly productKey: string; readonly hasEffectiveLink: boolean } };
  expect(telo.item.productKey).toBe("PR-ITEM-MIMO");
  expect(telo.item.hasEffectiveLink).toBe(true);
});

it("manuálny override (product_supplier_link_override) sa premietne do hasEffectiveLink cez jednoproduktový endpoint rovnako ako v zozname", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-ITEM-OVERRIDE", { name: "Produkt s override" });
  await db.insert(productSupplierLinkOverrides).values({ productKey: "PR-ITEM-OVERRIDE", url: "https://dodavatel.example.com/override", updatedAt: new Date() });

  const res = await app.request("/api/pairing-review/PR-ITEM-OVERRIDE", { headers: { cookie } });
  expect(res.status).toBe(200);
  const telo = (await res.json()) as { readonly item: { readonly hasEffectiveLink: boolean } };
  expect(telo.item.hasEffectiveLink).toBe(true);
});
