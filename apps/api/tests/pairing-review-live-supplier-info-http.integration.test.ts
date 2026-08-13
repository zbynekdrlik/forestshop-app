import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { Fetcher } from "../src/modules/pairing-search/client.js";
import { SearchClient } from "../src/modules/pairing-search/client.js";
import { users } from "../src/db/schema.js";
import { withCleanDb } from "./helpers/db.js";

// issue 422 — "Živé ceny/dostupnosť": `GET /api/pairing-review/live-
// supplier-info`. Injektovaný `Fetcher` (nikdy skutočná sieť, `.claude/
// rules/pairing-search.md`'s zavedená disciplína — testy nikdy nechodia na
// dodávateľskú stránku naozaj) vracia fixture HTML podľa URL.

const HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo

const WETLAND_JSON_LD = `<html><body><script type="application/ld+json">
{"@type":"Product","offers":{"@type":"Offer","priceCurrency":"EUR","price":"149.9","availability":"https://schema.org/BackOrder"}}
</script></body></html>`;

const BETALOV_PRODDATA = `<html><body><script>
var prodData = {"item_name":"x","price":36.5,"is_item_in_stock":1};
</script></body></html>`;

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot(fetcher: Fetcher) {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({ email: "manazer@forestshop.sk", passwordHash: await hashPassword(HESLO), displayName: "Manažér", role: "citanie" });

  const app = createApp(ctx.db, { cookieSecure: false, pairingSearchClient: new SearchClient({ fetcher }) });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie };
}

it("bez prihlásenia vráti 401", async () => {
  const { app } = await boot(() => Promise.resolve(""));
  expect((await app.request("/api/pairing-review/live-supplier-info?url=https://www.wetland.sk/x")).status).toBe(401);
});

it("WETLAND URL (adaptér podľa hosta) — vráti price+availabilityText z JSON-LD Offer fixtúry", async () => {
  const { app, cookie } = await boot(() => Promise.resolve(WETLAND_JSON_LD));
  const res = await app.request("/api/pairing-review/live-supplier-info?url=https://www.wetland.sk/nohavice/x-1", { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ price: "149.90", availabilityText: "Nedostupné" });
});

it("BETALOV (huntingshop.eu) URL — vráti price+availabilityText z prodData fixtúry", async () => {
  const { app, cookie } = await boot(() => Promise.resolve(BETALOV_PRODDATA));
  const res = await app.request("/api/pairing-review/live-supplier-info?url=https://www.huntingshop.eu/nohavice-1", { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ price: "36.50", availabilityText: "Skladom" });
});

it("URL mimo troch známych adaptérov — vráti price:null/availabilityText:null, BEZ akéhokoľvek volania fetchera", async () => {
  let calls = 0;
  const { app, cookie } = await boot(() => {
    calls += 1;
    return Promise.resolve(WETLAND_JSON_LD);
  });
  const res = await app.request("/api/pairing-review/live-supplier-info?url=https://e2e-dodavatel.example.com/produkt", { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ price: null, availabilityText: null });
  expect(calls).toBe(0);
});

it("zlyhaný fetch (sieťová chyba) degraduje na 200 s price:null/availabilityText:null, nikdy 500", async () => {
  const { app, cookie } = await boot(() => Promise.reject(new Error("timeout")));
  const res = await app.request("/api/pairing-review/live-supplier-info?url=https://www.wetland.sk/nohavice/x-1", { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ price: null, availabilityText: null });
});

it("nevalidná (nie http/https) URL vráti 400", async () => {
  const { app, cookie } = await boot(() => Promise.resolve(WETLAND_JSON_LD));
  const res = await app.request("/api/pairing-review/live-supplier-info?url=nie-je-to-url", { headers: { cookie } });
  expect(res.status).toBe(400);
});
