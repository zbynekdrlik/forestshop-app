import { afterEach, expect, it } from "vitest";
import { productSupplierLinkOverrides, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestSnapshot } from "./helpers/catalog.js";
import { withCleanDb } from "./helpers/db.js";
import { seedPairingReviewProduct as seedProduct } from "./helpers/pairing-review.js";

// issue 432 — `GET /api/pairing-review` popri veľkosti recenznej FRONTY
// (`gatheredTotal`/`linkedTotal`) vracia aj SKUTOČNÉ katalógové pokrytie
// linkami: `catalogActive` (produkty s aspoň jedným PREDAJNÝM — `state =
// 'sellable'` — variantom, menovateľ) a `catalogLinked` (z aktívnych tie s
// EFEKTÍVNOU linkou = override ∪ `internalNote` extrakcia, čitateľ). Vyčlenené
// do vlastného súboru (`.claude/rules/testing.md`'s `max-lines: 400` vzor —
// `pairing-review-http.integration.test.ts` je už na 382 riadkoch).

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
  readonly catalogLinked: number;
  readonly catalogActive: number;
}

async function fetchCoverage(app: Awaited<ReturnType<typeof boot>>["app"], cookie: string): Promise<Telo> {
  return (await (await app.request("/api/pairing-review?filter=all&pageSize=1", { headers: { cookie } })).json()) as Telo;
}

// Design bod 3 na tickete: override link počíta sa · internal_note URL počíta
// sa · bez linky nepočíta sa (len do menovateľa) · bez sellable variantu nie
// je ani v menovateli.
it("issue 432: catalogLinked/catalogActive merajú katalógové pokrytie, nie veľkosť recenznej fronty", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);

  // (1) override link + sellable variant → čitateľ AJ menovateľ.
  await seedProduct(db, snapshotId, "CC-OVERRIDE", { name: "Produkt s override linkou" });
  await db.insert(productSupplierLinkOverrides).values({ productKey: "CC-OVERRIDE", url: "https://dodavatel.example.com/override", updatedAt: new Date() });

  // (2) internal_note URL + sellable variant → čitateľ AJ menovateľ (efektívna
  // linka cez extrakciu z voľného textu, žiadny override).
  await seedProduct(db, snapshotId, "CC-NOTE", { name: "Produkt s linkou v poznámke", internalNote: "Dodávateľ: https://dodavatel.example.com/z-poznamky" });

  // (3) bez linky + sellable variant → LEN menovateľ.
  await seedProduct(db, snapshotId, "CC-NOLINK", { name: "Produkt bez linky" });

  // (4) má override linku, ALE žiadny sellable variant (ukončený) → NIE JE v
  // menovateli (a teda ani v čitateli) — presne to, čo tlačí prod číslo dole,
  // keby sa rátal celý katalóg.
  await seedProduct(db, snapshotId, "CC-DISCONTINUED", { name: "Ukončený produkt s linkou", variants: [{ code: "CC-DISCONTINUED/1", state: "discontinued" }] });
  await db.insert(productSupplierLinkOverrides).values({ productKey: "CC-DISCONTINUED", url: "https://dodavatel.example.com/ukonceny", updatedAt: new Date() });

  const telo = await fetchCoverage(app, cookie);

  // Menovateľ = aktívne produkty (aspoň jeden sellable variant): CC-OVERRIDE,
  // CC-NOTE, CC-NOLINK — nie CC-DISCONTINUED.
  expect(telo.catalogActive).toBe(3);
  // Čitateľ = aktívne produkty s efektívnou linkou: CC-OVERRIDE, CC-NOTE.
  expect(telo.catalogLinked).toBe(2);
});

// Pokrytie katalógu sa počíta NEZÁVISLE od populácie recenznej fronty — aj
// keď je fronta prázdna (produkt už MÁ efektívnu linku, nebol gatherovaný ani
// rozhodnutý, takže NIE JE v populácii), aktívny olinkovaný produkt sa v
// pokrytí objaví. Toto je práve prípad, ktorý front-based `linkedTotal` minul.
it("issue 432: aktívny olinkovaný produkt MIMO recenznej fronty sa ráta do pokrytia", async () => {
  const { app, cookie, db } = await boot("citanie");
  const snapshotId = await insertTestSnapshot(db);

  await seedProduct(db, snapshotId, "CC-LINKED-NOQUEUE", { name: "Olinkovaný, mimo fronty", internalNote: "https://dodavatel.example.com/mimo-fronty" });

  const telo = await fetchCoverage(app, cookie);

  // Fronta ho NEobsahuje (má linku, nebol gatherovaný/rozhodnutý).
  expect(telo.gatheredTotal).toBe(0);
  expect(telo.linkedTotal).toBe(0);
  // Katalógové pokrytie ho VŠAK zaráta (aktívny + olinkovaný).
  expect(telo.catalogActive).toBe(1);
  expect(telo.catalogLinked).toBe(1);
});
