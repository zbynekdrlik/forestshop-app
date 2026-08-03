import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { users } from "../src/db/schema.js";
import { withCleanDb } from "./helpers/db.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

const HESLO = "test-heslo-abc";     // testovacie údaje, nie tajomstvo
const ZLE_HESLO = "nespravne";
const NOVE_HESLO = ["nove", "tajne", "heslo", "xyz"].join("-"); // testovacie údaje, nie tajomstvo

async function boot() {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({
    email: "manazer@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Manažér",
    role: "manazer",
  });
  return createApp(ctx.db, { cookieSecure: false });
}

it("GET /api/version vráti verziu aj bez prihlásenia", async () => {
  const app = await boot();
  const res = await app.request("/api/version");
  expect(res.status).toBe(200);
  expect(((await res.json()) as { version: string }).version).toMatch(/^\d+\.\d+\.\d+/);
});

// issue 188: ZÁMERNE 200 s telom `null`, nie 401 — Chromium loguje každú 4xx
// odpoveď do konzoly ako chybu, takže 401 tu robilo červenú chybu na
// prihlasovacej obrazovke úplne v poriadku fungujúcej appky.
it("GET /api/me bez prihlásenia vráti 200 a telo null", async () => {
  const app = await boot();
  const res = await app.request("/api/me");
  expect(res.status).toBe(200);
  expect(await res.json()).toBeNull();
});

it("prihlásenie nastaví cookie a /api/me potom vráti používateľa", async () => {
  const app = await boot();
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("fs_session=");
  expect(cookie).toContain("HttpOnly");

  const me = await app.request("/api/me", { headers: { cookie: cookie.split(";")[0] ?? "" } });
  expect(me.status).toBe(200);
  expect((await me.json()) as { role: string }).toMatchObject({ role: "manazer" });
});

it("zlé heslo vráti 401 a nenastaví cookie", async () => {
  const app = await boot();
  const res = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: ZLE_HESLO }),
  });
  expect(res.status).toBe(401);
  expect(res.headers.get("set-cookie")).toBeNull();
});

it("telo bez e-mailu vráti 400", async () => {
  const app = await boot();
  const res = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ZLE_HESLO }),
  });
  expect(res.status).toBe(400);
});

it("neznáma /api/* cesta vráti JSON 404 namiesto SPA fallbacku", async () => {
  const app = await boot();
  const res = await app.request("/api/neexistuje");
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string };
  expect(typeof body.error).toBe("string");
});

it("11. pokus o prihlásenie z tej istej IP a e-mailu je odmietnutý (429), iná IP/e-mail nie je ovplyvnená", async () => {
  const app = await boot();
  const attempt = (ip: string, email: string) =>
    app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email, password: ZLE_HESLO }),
    });

  for (let i = 0; i < 10; i++) {
    const res = await attempt("203.0.113.1", "manazer@forestshop.sk");
    expect(res.status).toBe(401); // zlé heslo, ale nie limitované
  }
  const eleventh = await attempt("203.0.113.1", "manazer@forestshop.sk");
  expect(eleventh.status).toBe(429);

  const inaIp = await attempt("203.0.113.2", "manazer@forestshop.sk");
  expect(inaIp.status).toBe(401);

  const inyEmail = await attempt("203.0.113.1", "iny@forestshop.sk");
  expect(inyEmail.status).toBe(401);
});

it("sprejovanie mnohých rôznych e-mailov z JEDNEJ IP narazí na samostatný IP limit", async () => {
  const app = await boot();
  const attempt = (ip: string, email: string) =>
    app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email, password: ZLE_HESLO }),
    });

  const ip = "203.0.113.9";
  // 30 pokusov, KAŽDÝ s iným e-mailom — per-(IP, e-mail) limit (10) sa tu
  // nikdy neuplatní, lebo žiadny e-mail sa nezopakuje.
  for (let i = 0; i < 30; i++) {
    const res = await attempt(ip, `neznamy-${String(i)}@forestshop.sk`);
    expect(res.status).toBe(401);
  }
  const dalsi = await attempt(ip, "neznamy-30@forestshop.sk");
  expect(dalsi.status).toBe(429);

  // odpoveď na 429 neprezrádza, či e-mail existuje — rovnaké telo ako pri
  // limite na (IP, e-mail) pár vyššie.
  const body = (await dalsi.json()) as { error: string };
  expect(body.error).toBe("Priveľa pokusov o prihlásenie. Skúste to znova o pár minút.");

  // iná IP nie je ovplyvnená sprejovaním na prvej
  const inaIp = await attempt("203.0.113.10", "neznamy-0@forestshop.sk");
  expect(inaIp.status).toBe(401);
});

it("POST /api/me/password zmení heslo prihláseného používateľa (#10)", async () => {
  const app = await boot();
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const zmena = await app.request("/api/me/password", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ oldPassword: HESLO, newPassword: NOVE_HESLO }),
  });
  expect(zmena.status).toBe(200);

  const staryPrihlasenie = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  expect(staryPrihlasenie.status).toBe(401);

  const novyPrihlasenie = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: NOVE_HESLO }),
  });
  expect(novyPrihlasenie.status).toBe(200);
});

it("POST /api/me/password so zlým starým heslom vráti 200 s ok:false a heslo nezmení", async () => {
  const app = await boot();
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const zmena = await app.request("/api/me/password", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ oldPassword: ZLE_HESLO, newPassword: NOVE_HESLO }),
  });
  // Zámerne 200 aj tu (nie 4xx) — pozri komentár pri trase v `http/app.ts`:
  // "zlé staré heslo" je bežný domény výsledok, nie HTTP chyba, a 4xx by
  // Chromiu prinútilo zalogovať "Failed to load resource" do konzoly, čo by
  // v e2e teste porušilo jedinú dnes povolenú (a rozširovanie zakazujúcu)
  // výnimku (`testing.md`).
  expect(zmena.status).toBe(200);
  expect(await zmena.json()).toEqual({ ok: false, error: "Nesprávne staré heslo" });

  const staryPrihlasenie = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  expect(staryPrihlasenie.status).toBe(200);
});

it("POST /api/me/password s príliš krátkym novým heslom vráti 400", async () => {
  const app = await boot();
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const zmena = await app.request("/api/me/password", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ oldPassword: HESLO, newPassword: "krat" }),
  });
  expect(zmena.status).toBe(400);
});

it("POST /api/me/password bez prihlásenia vráti 401", async () => {
  const app = await boot();
  const res = await app.request("/api/me/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ oldPassword: HESLO, newPassword: NOVE_HESLO }),
  });
  expect(res.status).toBe(401);
});

it("POST /api/me/password s cudzím Origin je odmietnuté (403)", async () => {
  const app = await boot();
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const res = await app.request("/api/me/password", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "https://utocnik.example",
      host: "forestshop.example",
    },
    body: JSON.stringify({ oldPassword: HESLO, newPassword: NOVE_HESLO }),
  });
  expect(res.status).toBe(403);
});

it("odhlásenie s cudzím Origin je odmietnuté (403), rovnaký pôvod prejde", async () => {
  const app = await boot();

  const cudzi = await app.request("/api/logout", {
    method: "POST",
    headers: { origin: "https://utocnik.example", host: "forestshop.example" },
  });
  expect(cudzi.status).toBe(403);

  const rovnaky = await app.request("/api/logout", {
    method: "POST",
    headers: { origin: "https://forestshop.example", host: "forestshop.example" },
  });
  expect(rovnaky.status).toBe(200);

  const bezHlaviciek = await app.request("/api/logout", { method: "POST" });
  expect(bezHlaviciek.status).toBe(200);
});
