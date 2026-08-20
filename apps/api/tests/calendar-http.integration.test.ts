import { afterEach, expect, it } from "vitest";
import { users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { createNextEventService, type NextEventService } from "../src/modules/calendar/service.js";
import { withCleanDb } from "./helpers/db.js";

// issue 309: HTTP vrstva "Eshop → Upozornenia" — najbližšia udalosť z
// Google kalendára. `fetchIcs` je VŽDY injektovaná falošná implementácia —
// appka NIKDY nekontaktuje skutočný Google z testu (rovnaká bezpečnostná
// podmienka ako `dpd-http.integration.test.ts`'s `DpdRunDeps`).
const HESLO = "test-heslo-abc";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot(nextEvent?: NextEventService) {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({
    email: "pouzivatel@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Test",
    role: "manazer",
  });
  const app = createApp(ctx.db, { cookieSecure: false, ...(nextEvent === undefined ? {} : { nextEvent }) });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "pouzivatel@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie };
}

// Dátum je vždy "zajtra od TERAZ" (nikdy pevný literál) — test musí zostať
// zelený bez ohľadu na to, KEDY sa beh spustí, nielen v okne pred 12. 8.
// 2026 (rovnaká disciplína ako `regression-test-first.md`'s "nikdy
// časovaná pasca").
function icsWithEventTomorrow(): string {
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:test-event@forestshop",
    "DTSTAMP:20260101T000000Z",
    "SUMMARY:Stretnutie s dodávateľom",
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

it("bez dodanej nextEvent service vráti configured:false, žiadny fetch sa nevolá", async () => {
  const { app, cookie } = await boot();
  const res = await app.request("/api/upozornenia/next-event", { headers: { cookie } });
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toEqual({ configured: false, events: [], error: false });
});

// issue 382: majiteľ chce TRI najbližšie udalosti — trasa vracia pole
// `events`, nie singulárnu `event` hodnotu.
it("s nakonfigurovanou service vráti najbližšie udalosti z (falošne) stiahnutého ICS", async () => {
  const service = createNextEventService([() => Promise.resolve(icsWithEventTomorrow())]);
  const { app, cookie } = await boot(service);
  const res = await app.request("/api/upozornenia/next-event", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { configured: boolean; error: boolean; events: { title: string; allDay: boolean }[] };
  expect(body.configured).toBe(true);
  expect(body.error).toBe(false);
  expect(body.events).toHaveLength(1);
  expect(body.events[0]?.title).toBe("Stretnutie s dodávateľom");
  expect(body.events[0]?.allDay).toBe(false);
});

it("keď fetch zlyhá, appka vráti error:true, nikdy surovú chybu ani pád", async () => {
  const service = createNextEventService([() => Promise.reject(new Error("simulovaný sieťový výpadok"))]);
  const { app, cookie } = await boot(service);
  const res = await app.request("/api/upozornenia/next-event", { headers: { cookie } });
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toEqual({ configured: true, events: [], error: true });
});

it("neprihlásený dostane 401", async () => {
  const { app } = await boot();
  const res = await app.request("/api/upozornenia/next-event");
  expect(res.status).toBe(401);
});
