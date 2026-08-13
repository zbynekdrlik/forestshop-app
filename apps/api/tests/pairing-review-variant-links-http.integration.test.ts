import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { auditEvents, pairingDecisions, pairingVariantLinks, productSupplierLinkOverrides, users, variants } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";
import { seedPairingCandidateSet as seedCandidateSet, seedPairingReviewProduct as seedProduct } from "./helpers/pairing-review.js";

// issue 399 — "✂ Rozdeliť na veľkosti": `GET/POST /api/pairing-review/
// :productKey/variants`/`variant-link` (per-veľkosť linky) + `pairing_decision
// .status = 'split'` (`POST .../decision`). Vyčlenené do vlastného súboru
// (rovnaký `.claude/rules/testing.md` split vzor ako sesterské pairing-review
// integračné testy), aby ani jeden nenarástol cez eslint `max-lines: 400`.

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

function setVariantLink(app: ReturnType<typeof createApp>, cookie: string, productKey: string, body: unknown) {
  return app.request(`/api/pairing-review/${productKey}/variant-link`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

function decide(app: ReturnType<typeof createApp>, cookie: string, productKey: string, body: unknown) {
  return app.request(`/api/pairing-review/${productKey}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function seedTwoSizeProduct(db: Awaited<ReturnType<typeof boot>>["db"], snapshotId: string, productKey: string): Promise<void> {
  await seedProduct(db, snapshotId, productKey, {
    name: "Bunda viacveľkostná",
    variants: [
      { code: `${productKey}/S` },
      { code: `${productKey}/M` },
    ],
  });
}

it("GET .../variants bez prihlásenia vráti 401", async () => {
  const { app } = await boot("manazer");
  expect((await app.request("/api/pairing-review/X/variants")).status).toBe(401);
});

it("GET .../variants vráti KAŽDÝ variant produktu s null linkom, kým nič nie je uložené", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedTwoSizeProduct(db, snapshotId, "PR-SPLIT-LIST");

  const res = await app.request("/api/pairing-review/PR-SPLIT-LIST/variants", { headers: { cookie } });
  expect(res.status).toBe(200);
  const telo = (await res.json()) as { readonly variants: { readonly code: string; readonly url: string | null }[] };
  expect(telo.variants.map((v) => v.code).sort()).toEqual(["PR-SPLIT-LIST/M", "PR-SPLIT-LIST/S"]);
  expect(telo.variants.every((v) => v.url === null)).toBe(true);
});

it("rola 'citanie' nemá právo zapísať variant-link (403)", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedTwoSizeProduct(db, snapshotId, "PR-SPLIT-403");

  const res = await setVariantLink(app, cookie, "PR-SPLIT-403", { code: "PR-SPLIT-403/S", url: "https://dodavatel.example.com/s" });
  expect(res.status).toBe(403);
});

it("POST .../variant-link uloží per-veľkosť URL, nezapíše product_supplier_link_override, audit záznam existuje", async () => {
  const { app, cookie, db, userId } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedTwoSizeProduct(db, snapshotId, "PR-SPLIT-SAVE");

  const res = await setVariantLink(app, cookie, "PR-SPLIT-SAVE", { code: "PR-SPLIT-SAVE/S", url: "https://dodavatel.example.com/velkost-s" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, code: "PR-SPLIT-SAVE/S", url: "https://dodavatel.example.com/velkost-s" });

  const [row] = await db.select().from(pairingVariantLinks).where(eq(pairingVariantLinks.code, "PR-SPLIT-SAVE/S"));
  expect(row?.url).toBe("https://dodavatel.example.com/velkost-s");

  const overrides = await db.select().from(productSupplierLinkOverrides).where(eq(productSupplierLinkOverrides.productKey, "PR-SPLIT-SAVE"));
  expect(overrides).toHaveLength(0);

  const events = await db.select().from(auditEvents).where(eq(auditEvents.entityId, "PR-SPLIT-SAVE/S"));
  expect(events.some((e) => e.action === "pairing_variant_link.changed" && e.actorUserId === userId)).toBe(true);
});

it("POST .../variant-link s kódom PATRIACIM INÉMU produktu vráti 404, nič sa nezapíše", async () => {
  const { app, cookie, db } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedTwoSizeProduct(db, snapshotId, "PR-SPLIT-A");
  await seedProduct(db, snapshotId, "PR-SPLIT-B", { name: "Iný produkt" });

  const res = await setVariantLink(app, cookie, "PR-SPLIT-B", { code: "PR-SPLIT-A/S", url: "https://dodavatel.example.com/x" });
  expect(res.status).toBe(404);

  const rows = await db.select().from(pairingVariantLinks).where(eq(pairingVariantLinks.code, "PR-SPLIT-A/S"));
  expect(rows).toHaveLength(0);
});

it("POST .../variant-link s prázdnym url VYMAŽE existujúci riadok (idempotentné, no-op keď už nič nie je)", async () => {
  const { app, cookie, db } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedTwoSizeProduct(db, snapshotId, "PR-SPLIT-CLEAR");
  expect((await setVariantLink(app, cookie, "PR-SPLIT-CLEAR", { code: "PR-SPLIT-CLEAR/S", url: "https://dodavatel.example.com/s" })).status).toBe(200);

  const res = await setVariantLink(app, cookie, "PR-SPLIT-CLEAR", { code: "PR-SPLIT-CLEAR/S", url: "" });
  expect(res.status).toBe(200);
  const rows = await db.select().from(pairingVariantLinks).where(eq(pairingVariantLinks.code, "PR-SPLIT-CLEAR/S"));
  expect(rows).toHaveLength(0);

  // Druhý raz na už-prázdnom riadku je no-op ok, nikdy chyba.
  const res2 = await setVariantLink(app, cookie, "PR-SPLIT-CLEAR", { code: "PR-SPLIT-CLEAR/S", url: null });
  expect(res2.status).toBe(200);
});

it("POST .../variant-link s neplatnou URL (nie http) zlyhá na zod validácii, nič sa nezapíše", async () => {
  const { app, cookie, db } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedTwoSizeProduct(db, snapshotId, "PR-SPLIT-BADURL");

  const res = await setVariantLink(app, cookie, "PR-SPLIT-BADURL", { code: "PR-SPLIT-BADURL/S", url: "nie-je-to-url" });
  expect(res.status).toBe(400);
  const rows = await db.select().from(pairingVariantLinks).where(eq(pairingVariantLinks.code, "PR-SPLIT-BADURL/S"));
  expect(rows).toHaveLength(0);
});

// issue 399 — jadro celej funkcie: decision status "split" OZNAČÍ produkt
// rozdelený (žiadny override zápis, produkt je zrevidovaný AJ bez efektívnej
// linky — rovnaký princíp ako "unavailable"/"discontinued", ale "split" MÁ
// per-veľkosť linky uložené v `pairingVariantLinks`, nie v `pairing_decision.url`).
it("decision 'split': žiadny override, produkt vypadne z 'unreviewed' aj bez efektívnej linky; per-veľkosť linky ostávajú NEDOTKNUTÉ", async () => {
  const { app, cookie, db } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedTwoSizeProduct(db, snapshotId, "PR-SPLIT-DECIDE");
  await seedCandidateSet(db, "PR-SPLIT-DECIDE", { confidence: "none" });
  expect((await setVariantLink(app, cookie, "PR-SPLIT-DECIDE", { code: "PR-SPLIT-DECIDE/S", url: "https://dodavatel.example.com/s" })).status).toBe(200);
  expect((await setVariantLink(app, cookie, "PR-SPLIT-DECIDE", { code: "PR-SPLIT-DECIDE/M", url: "https://dodavatel.example.com/m" })).status).toBe(200);

  const unreviewedBefore = (await (await app.request("/api/pairing-review?filter=unreviewed&pageSize=200", { headers: { cookie } })).json()) as {
    readonly items: { readonly productKey: string }[];
  };
  expect(unreviewedBefore.items.some((i) => i.productKey === "PR-SPLIT-DECIDE")).toBe(true);

  const res = await decide(app, cookie, "PR-SPLIT-DECIDE", { status: "split" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, status: "split" });

  const [decision] = await db.select().from(pairingDecisions).where(eq(pairingDecisions.productKey, "PR-SPLIT-DECIDE"));
  expect(decision?.status).toBe("split");
  expect(decision?.url).toBeNull();

  const overrides = await db.select().from(productSupplierLinkOverrides).where(eq(productSupplierLinkOverrides.productKey, "PR-SPLIT-DECIDE"));
  expect(overrides).toHaveLength(0);

  const unreviewedAfter = (await (await app.request("/api/pairing-review?filter=unreviewed&pageSize=200", { headers: { cookie } })).json()) as {
    readonly items: { readonly productKey: string }[];
  };
  expect(unreviewedAfter.items.some((i) => i.productKey === "PR-SPLIT-DECIDE")).toBe(false);

  // Per-veľkosť linky uložené PRED rozhodnutím zostávajú nedotknuté.
  const links = await db.select().from(pairingVariantLinks).where(eq(pairingVariantLinks.code, "PR-SPLIT-DECIDE/S"));
  expect(links[0]?.url).toBe("https://dodavatel.example.com/s");
});

// issue 399 — "↩ Vrátiť" (revert) na 'split' NIKDY nemaže per-veľkosť linky
// (rovnaká asymetria/konvencia ako "Vrátiť" na 'unavailable'/'discontinued'
// nikdy nemaže `product_supplier_link_override`, `.claude/rules/pairing-
// search.md`'s E6 sekcia) — opätovné rozdelenie ukáže predtým uložené hodnoty.
it("revert na 'split' zmaže LEN decision riadok — per-veľkosť linky prežijú, produkt sa vráti do 'unreviewed'", async () => {
  const { app, cookie, db } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedTwoSizeProduct(db, snapshotId, "PR-SPLIT-REVERT");
  expect((await setVariantLink(app, cookie, "PR-SPLIT-REVERT", { code: "PR-SPLIT-REVERT/S", url: "https://dodavatel.example.com/s" })).status).toBe(200);
  expect((await decide(app, cookie, "PR-SPLIT-REVERT", { status: "split" })).status).toBe(200);

  const res = await decide(app, cookie, "PR-SPLIT-REVERT", { status: "revert" });
  expect(res.status).toBe(200);

  const decisionRows = await db.select().from(pairingDecisions).where(eq(pairingDecisions.productKey, "PR-SPLIT-REVERT"));
  expect(decisionRows).toHaveLength(0);

  const linkRows = await db.select().from(pairingVariantLinks).where(eq(pairingVariantLinks.code, "PR-SPLIT-REVERT/S"));
  expect(linkRows).toHaveLength(1);
  expect(linkRows[0]?.url).toBe("https://dodavatel.example.com/s");

  const unreviewed = (await (await app.request("/api/pairing-review?filter=unreviewed&pageSize=200", { headers: { cookie } })).json()) as {
    readonly items: { readonly productKey: string }[];
  };
  expect(unreviewed.items.some((i) => i.productKey === "PR-SPLIT-REVERT")).toBe(true);
});

it("CHECK obmedzenie: 'split' s VYPLNENOU url zlyhá na DB úrovni", async () => {
  const { db, userId } = await boot("manazer");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-SPLIT-CHECK", { name: "Produkt" });
  const now = new Date();
  await expect(
    db.insert(pairingDecisions).values({ productKey: "PR-SPLIT-CHECK", status: "split", url: "https://x.example.com", decidedBy: userId, decidedAt: now, updatedAt: now }),
  ).rejects.toThrow();
});

// issue 399 — poradie panela je podľa `sizeLabel` (sk locale), NIE podľa
// poradia vloženia/`code` — "L" < "S" abecedne, takže A (sizeLabel "L")
// predchádza B (sizeLabel "S") bez ohľadu na to, že B bol vložený PRVÝ.
it("GET .../variants zoradí podľa sizeLabel (sk locale), nie podľa poradia vloženia", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-SPLIT-ORDER", {
    name: "Produkt s veľkosťami",
    variants: [{ code: "PR-SPLIT-ORDER/B" }, { code: "PR-SPLIT-ORDER/A" }],
  });
  await db.update(variants).set({ sizeLabel: "L" }).where(eq(variants.code, "PR-SPLIT-ORDER/A"));
  await db.update(variants).set({ sizeLabel: "S" }).where(eq(variants.code, "PR-SPLIT-ORDER/B"));

  const res = await app.request("/api/pairing-review/PR-SPLIT-ORDER/variants", { headers: { cookie } });
  const telo = (await res.json()) as { readonly variants: { readonly code: string; readonly sizeLabel: string | null }[] };
  expect(telo.variants.map((v) => v.code)).toEqual(["PR-SPLIT-ORDER/A", "PR-SPLIT-ORDER/B"]);
});

// issue 399 — variant BEZ sizeLabel (`null`) sa zoradí NAPOSLEDY, nikdy pred
// pomenovanými veľkosťami (rovnaký princíp ako existujúci "prázdne/`null`
// naposledy" komentár v `variant-links.ts`).
it("GET .../variants dá variant BEZ sizeLabel na koniec zoznamu", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);
  await seedProduct(db, snapshotId, "PR-SPLIT-NOLABEL", {
    name: "Produkt s aj bez veľkosti",
    variants: [{ code: "PR-SPLIT-NOLABEL/UNI" }, { code: "PR-SPLIT-NOLABEL/M" }],
  });
  await db.update(variants).set({ sizeLabel: "M" }).where(eq(variants.code, "PR-SPLIT-NOLABEL/M"));

  const res = await app.request("/api/pairing-review/PR-SPLIT-NOLABEL/variants", { headers: { cookie } });
  const telo = (await res.json()) as { readonly variants: { readonly code: string }[] };
  expect(telo.variants.map((v) => v.code)).toEqual(["PR-SPLIT-NOLABEL/M", "PR-SPLIT-NOLABEL/UNI"]);
});
