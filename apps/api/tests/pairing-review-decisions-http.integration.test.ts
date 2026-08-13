import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { auditEvents, pairingDecisions, productSupplierLinkOverrides, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";
import { seedPairingCandidateSet as seedCandidateSet, seedPairingReviewProduct as seedProduct } from "./helpers/pairing-review.js";

// issue 387 E6: "Eshop → Párovanie" — rozhodnutia (`POST /api/pairing-review/
// :productKey/decision`, `GET /api/pairing-review/:productKey/candidates`).
// Vyčlenené OD `pairing-review-http.integration.test.ts` (E5, čisté čítanie),
// aby ani jeden súbor nenarástol cez eslint `max-lines: 400` (`.claude/rules/
// testing.md`'s zavedený vzor).

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

function decide(app: ReturnType<typeof createApp>, cookie: string, productKey: string, body: unknown) {
  return app.request(`/api/pairing-review/${productKey}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function unreviewedKeys(app: ReturnType<typeof createApp>, cookie: string): Promise<string[]> {
  const telo = (await (await app.request("/api/pairing-review?filter=unreviewed&pageSize=100", { headers: { cookie } })).json()) as {
    readonly items: { readonly productKey: string }[];
  };
  return telo.items.map((i) => i.productKey);
}

it("bez prihlásenia vráti 401", async () => {
  const { app } = await boot("manazer");
  expect((await decide(app, "", "X", { status: "good" })).status).toBe(401);
});

it("rola 'citanie' nemá právo rozhodovať (403)", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-403", { name: "Produkt" });
  await seedCandidateSet(db, "PR-403", { chosenUrl: "https://d.example.com/x" });

  expect((await decide(app, cookie, "PR-403", { status: "good" })).status).toBe(403);
});

it("'good': v JEDNEJ transakcii zapíše override AJ pairing_decision, okamžite viditeľné na hasEffectiveLink; oba audit záznamy existujú", async () => {
  const { app, cookie, db, userId } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-GOOD", { name: "Bunda Alfa" });
  await seedCandidateSet(db, "PR-GOOD", {
    chosenUrl: "https://dodavatel.example.com/bunda-alfa",
    candidates: [{ url: "https://dodavatel.example.com/bunda-alfa", name: "Bunda Alfa u dodávateľa", rawScore: "1080.0000", codeHit: true }],
  });

  const res = await decide(app, cookie, "PR-GOOD", { status: "good" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, status: "good" });

  const [override] = await db.select().from(productSupplierLinkOverrides).where(eq(productSupplierLinkOverrides.productKey, "PR-GOOD"));
  expect(override?.url).toBe("https://dodavatel.example.com/bunda-alfa");

  const [decision] = await db.select().from(pairingDecisions).where(eq(pairingDecisions.productKey, "PR-GOOD"));
  expect(decision?.status).toBe("good");
  expect(decision?.url).toBe("https://dodavatel.example.com/bunda-alfa");
  expect(decision?.decidedBy).toBe(userId);
  expect(decision?.stateSyncedAt).toBeNull();

  const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, "PR-GOOD"));
  expect(events.map((e) => e.entity).sort()).toEqual(["pairing_decision", "product_supplier_link_override"]);

  const telo = (await (await app.request("/api/pairing-review?filter=all", { headers: { cookie } })).json()) as {
    readonly items: { readonly productKey: string; readonly hasEffectiveLink: boolean; readonly decision: { readonly status: string; readonly url: string | null } | null }[];
  };
  const item = telo.items.find((i) => i.productKey === "PR-GOOD");
  expect(item?.hasEffectiveLink).toBe(true);
  expect(item?.decision).toEqual({ status: "good", url: "https://dodavatel.example.com/bunda-alfa", decidedAt: expect.any(String) as string });
  expect(await unreviewedKeys(app, cookie)).not.toContain("PR-GOOD");
});

it("'good' bez navrhnutého kandidáta (confidence none) vráti 400 a NIČ nezapíše", async () => {
  const { app, cookie, db } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-NOCAND", { name: "Produkt bez kandidáta" });
  await seedCandidateSet(db, "PR-NOCAND", { confidence: "none" });

  const res = await decide(app, cookie, "PR-NOCAND", { status: "good" });
  expect(res.status).toBe(400);

  const rows = await db.select().from(pairingDecisions).where(eq(pairingDecisions.productKey, "PR-NOCAND"));
  expect(rows).toHaveLength(0);
});

it("'good' na produkte bez pairing_candidate_set riadku vráti 404", async () => {
  const { app, cookie, db } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-NEGATHER", { name: "Negatherovaný" });

  expect((await decide(app, cookie, "PR-NEGATHER", { status: "good" })).status).toBe(404);
});

it("'manual': zapíše KLIENTOM poslanú URL (vybraný kandidát alebo ručná adresa), nie chosenUrl", async () => {
  const { app, cookie, db } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-MANUAL", { name: "Produkt s výberom" });
  await seedCandidateSet(db, "PR-MANUAL", {
    chosenUrl: "https://dodavatel.example.com/top",
    candidates: [
      { url: "https://dodavatel.example.com/top", name: "Top kandidát", rawScore: "90.0000", codeHit: false },
      { url: "https://dodavatel.example.com/druhy", name: "Druhý kandidát", rawScore: "70.0000", codeHit: false },
    ],
  });

  const res = await decide(app, cookie, "PR-MANUAL", { status: "manual", url: "https://dodavatel.example.com/druhy" });
  expect(res.status).toBe(200);

  const [override] = await db.select().from(productSupplierLinkOverrides).where(eq(productSupplierLinkOverrides.productKey, "PR-MANUAL"));
  expect(override?.url).toBe("https://dodavatel.example.com/druhy");
  const [decision] = await db.select().from(pairingDecisions).where(eq(pairingDecisions.productKey, "PR-MANUAL"));
  expect(decision?.status).toBe("manual");
  expect(decision?.url).toBe("https://dodavatel.example.com/druhy");
});

it("'manual' s neplatnou URL (nie http) zlyhá na zod validácii skôr, než sa čokoľvek zapíše", async () => {
  const { app, cookie, db } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-BADURL", { name: "Produkt" });
  await seedCandidateSet(db, "PR-BADURL", { confidence: "none" });

  const res = await decide(app, cookie, "PR-BADURL", { status: "manual", url: "nie-je-to-url" });
  expect(res.status).toBe(400);
  const rows = await db.select().from(pairingDecisions).where(eq(pairingDecisions.productKey, "PR-BADURL"));
  expect(rows).toHaveLength(0);
});

it("'unavailable': žiadny override zápis, produkt je zrevidovaný (vypadne z 'unreviewed') aj bez linky", async () => {
  const { app, cookie, db } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-NEDOSTUPNY", { name: "Vypredaný produkt" });
  await seedCandidateSet(db, "PR-NEDOSTUPNY", { confidence: "none" });
  expect(await unreviewedKeys(app, cookie)).toContain("PR-NEDOSTUPNY");

  const res = await decide(app, cookie, "PR-NEDOSTUPNY", { status: "unavailable" });
  expect(res.status).toBe(200);

  const overrides = await db.select().from(productSupplierLinkOverrides).where(eq(productSupplierLinkOverrides.productKey, "PR-NEDOSTUPNY"));
  expect(overrides).toHaveLength(0);
  const [decision] = await db.select().from(pairingDecisions).where(eq(pairingDecisions.productKey, "PR-NEDOSTUPNY"));
  expect(decision?.status).toBe("unavailable");
  expect(decision?.url).toBeNull();

  expect(await unreviewedKeys(app, cookie)).not.toContain("PR-NEDOSTUPNY");
});

it("'discontinued': rovnaké správanie ako 'unavailable' — žiadny override, produkt je zrevidovaný", async () => {
  const { app, cookie, db } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-KONIEC", { name: "Ukončený produkt" });
  await seedCandidateSet(db, "PR-KONIEC", { confidence: "none" });

  const res = await decide(app, cookie, "PR-KONIEC", { status: "discontinued" });
  expect(res.status).toBe(200);

  const [decision] = await db.select().from(pairingDecisions).where(eq(pairingDecisions.productKey, "PR-KONIEC"));
  expect(decision?.status).toBe("discontinued");
  expect(await unreviewedKeys(app, cookie)).not.toContain("PR-KONIEC");
});

it("'revert' na produkte s TERMINÁLNYM rozhodnutím (unavailable) vráti produkt do 'unreviewed' — DELETE riadku", async () => {
  const { app, cookie, db } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-VRATIT", { name: "Produkt na vrátenie" });
  await seedCandidateSet(db, "PR-VRATIT", { confidence: "none" });
  expect((await decide(app, cookie, "PR-VRATIT", { status: "unavailable" })).status).toBe(200);
  expect(await unreviewedKeys(app, cookie)).not.toContain("PR-VRATIT");

  const res = await decide(app, cookie, "PR-VRATIT", { status: "revert" });
  expect(res.status).toBe(200);

  const rows = await db.select().from(pairingDecisions).where(eq(pairingDecisions.productKey, "PR-VRATIT"));
  expect(rows).toHaveLength(0);
  expect(await unreviewedKeys(app, cookie)).toContain("PR-VRATIT");

  const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, "PR-VRATIT"));
  expect(events.some((e) => e.action === "pairing_decision.reverted")).toBe(true);
});

// Zámerný dizajn (design komentár na tickete, issue 387 E6): "Vrátiť" NIKDY
// nemaže `product_supplier_link_override` — človek ho môže chcieť ponechať.
// Dôsledok: revert 'good'/'manual' rozhodnutia zmaže SAMOTNÉ rozhodnutie
// (odznak/panel na karte zmizne), ale keďže efektívna linka naďalej
// existuje, produkt NEVYPADNE do "unreviewed" (to by bolo v rozpore s E5's
// vlastnou definíciou "unreviewed = bez efektívnej linky") — nájditeľný je
// ďalej cez "Všetky"/"Napárované" filter.
it("'revert' na 'good' rozhodnutí zmaže decision riadok, ale NIKDY nezmaže override — produkt zostáva MIMO 'unreviewed'", async () => {
  const { app, cookie, db } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-VRATIT-GOOD", { name: "Dobre rozhodnutý produkt" });
  await seedCandidateSet(db, "PR-VRATIT-GOOD", { chosenUrl: "https://dodavatel.example.com/x" });
  expect((await decide(app, cookie, "PR-VRATIT-GOOD", { status: "good" })).status).toBe(200);

  expect((await decide(app, cookie, "PR-VRATIT-GOOD", { status: "revert" })).status).toBe(200);

  const decisionRows = await db.select().from(pairingDecisions).where(eq(pairingDecisions.productKey, "PR-VRATIT-GOOD"));
  expect(decisionRows).toHaveLength(0);
  const overrideRows = await db.select().from(productSupplierLinkOverrides).where(eq(productSupplierLinkOverrides.productKey, "PR-VRATIT-GOOD"));
  expect(overrideRows).toHaveLength(1);
  expect(await unreviewedKeys(app, cookie)).not.toContain("PR-VRATIT-GOOD");
});

it("'revert' na produkte BEZ rozhodnutia je idempotentný no-op — ok, žiadny nový audit záznam", async () => {
  const { app, cookie, db } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-NOOP", { name: "Nezrevidovaný produkt" });
  await seedCandidateSet(db, "PR-NOOP", { confidence: "none" });

  const res = await decide(app, cookie, "PR-NOOP", { status: "revert" });
  expect(res.status).toBe(200);

  const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, "PR-NOOP"));
  expect(events).toHaveLength(0);
});

it("prepísanie EXISTUJÚCEHO rozhodnutia (posledný zápis vyhráva) prepíše status/url a zaznamená PREDOŠLÚ hodnotu do auditu", async () => {
  const { app, cookie, db } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-PREPIS", { name: "Produkt na prepis" });
  await seedCandidateSet(db, "PR-PREPIS", { confidence: "none" });

  expect((await decide(app, cookie, "PR-PREPIS", { status: "unavailable" })).status).toBe(200);
  expect((await decide(app, cookie, "PR-PREPIS", { status: "discontinued" })).status).toBe(200);

  const [decision] = await db.select().from(pairingDecisions).where(eq(pairingDecisions.productKey, "PR-PREPIS"));
  expect(decision?.status).toBe("discontinued");

  const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, "PR-PREPIS"));
  const changed = events.filter((e) => e.action === "pairing_decision.changed");
  expect(changed).toHaveLength(2);
  const second = changed.find((e) => (e.data as { readonly newStatus: string }).newStatus === "discontinued");
  expect((second?.data as { readonly previousStatus: string | null }).previousStatus).toBe("unavailable");
});

it("GET /:productKey/candidates vráti top kandidátov zoradených podľa position", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-CANDS", { name: "Produkt s kandidátmi" });
  await seedCandidateSet(db, "PR-CANDS", {
    chosenUrl: "https://dodavatel.example.com/a",
    candidates: [
      { url: "https://dodavatel.example.com/a", name: "A", rawScore: "90.0000", codeHit: true },
      { url: "https://dodavatel.example.com/b", name: "B", rawScore: "50.0000", codeHit: false },
    ],
  });

  const res = await app.request("/api/pairing-review/PR-CANDS/candidates", { headers: { cookie } });
  expect(res.status).toBe(200);
  const telo = (await res.json()) as { readonly candidates: { readonly name: string; readonly url: string; readonly rawScore: number; readonly codeHit: boolean }[] };
  expect(telo.candidates.map((c) => c.name)).toEqual(["A", "B"]);
  expect(telo.candidates[0]).toMatchObject({ url: "https://dodavatel.example.com/a", rawScore: 90, codeHit: true });
});

it("GET /:productKey/candidates bez prihlásenia vráti 401", async () => {
  const { app } = await boot("manazer");
  expect((await app.request("/api/pairing-review/PR-X/candidates")).status).toBe(401);
});

it("CHECK obmedzenie: 'good'/'manual' s NULL url zlyhá na DB úrovni", async () => {
  const { db, userId } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-CHECK-1", { name: "Produkt" });
  const now = new Date();
  await expect(
    db.insert(pairingDecisions).values({ productKey: "PR-CHECK-1", status: "good", url: null, decidedBy: userId, decidedAt: now, updatedAt: now }),
  ).rejects.toThrow();
});

it("CHECK obmedzenie: 'unavailable'/'discontinued' s VYPLNENOU url zlyhá na DB úrovni", async () => {
  const { db, userId } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-CHECK-2", { name: "Produkt" });
  const now = new Date();
  await expect(
    db
      .insert(pairingDecisions)
      .values({ productKey: "PR-CHECK-2", status: "unavailable", url: "https://x.example.com", decidedBy: userId, decidedAt: now, updatedAt: now }),
  ).rejects.toThrow();
});
