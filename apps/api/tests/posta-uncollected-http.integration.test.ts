import { afterEach, expect, it } from "vitest";
import { orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import type { MailMessage } from "../src/modules/mail/transport.js";
import { withCleanDb } from "./helpers/db.js";

// issue 172: HTTP vrstva pre "Nevyzdvihnuté zásielky". Falošný tracking klient
// + falošný mail transport — NIKDY skutočné api.posta.sk ani skutočný SMTP
// (ticket's bezpečnostná podmienka pre testy).
const HESLO = "test-heslo-abc";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot(role: UserRole, options: { readonly sent?: MailMessage[]; readonly bccEmail?: string } = {}) {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({
    email: "pouzivatel@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Test",
    role,
  });

  const app = createApp(ctx.db, {
    cookieSecure: false,
    postaUncollected: {
      trackingClient: () =>
        Promise.resolve({
          results: [{ status: "ok", events: [{ stateCode: "notified", detailCode: "ZNP1AN", localDate: "2026-07-30", postOffice: { name: "Pošta 1" } }] }],
        }),
      mailTransport:
        options.sent === undefined
          ? undefined
          : (m: MailMessage) => {
              options.sent?.push(m);
              return Promise.resolve();
            },
      bccEmail: options.bccEmail,
      adminBaseUrl: "https://www.forestshop.sk",
    },
  });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "pouzivatel@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db };
}

it("GET bez prihlásenia vráti 401", async () => {
  const { app } = await boot("manazer");
  const res = await app.request("/api/posta-uncollected");
  expect(res.status).toBe(401);
});

it("GET vráti enabled=false hneď po migrácii (bezpečný default)", async () => {
  const { app, cookie } = await boot("citanie");
  const res = await app.request("/api/posta-uncollected", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { enabled: boolean; lastRun: unknown };
  expect(body.enabled).toBe(false);
  expect(body.lastRun).toBeNull();
});

it("rola citanie NESMIE prepnúť Štart/Stop (403)", async () => {
  const { app, cookie } = await boot("citanie");
  const res = await app.request("/api/posta-uncollected/enabled", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(res.status).toBe(403);
});

it("manazer prepne Štart/Stop a GET to hneď odzrkadlí", async () => {
  const { app, cookie } = await boot("manazer");
  const put = await app.request("/api/posta-uncollected/enabled", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(put.status).toBe(200);

  const res = await app.request("/api/posta-uncollected", { headers: { cookie } });
  const body = (await res.json()) as { enabled: boolean };
  expect(body.enabled).toBe(true);
});

it("'Spustiť teraz' funguje BEZ ohľadu na enabled=false, ale bez BCC neposlé nič", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent });
  await db.insert(orders).values({
    externalOrderId: "20600001",
    customerName: "Test",
    statusName: "Vybavená",
    placedAt: new Date("2026-07-25T00:00:00Z"),
    email: "zakaznik@example.sk",
    packageNumber: "EF1SK",
    shippingCarrierName: "Kuriér",
  });

  const res = await app.request("/api/posta-uncollected/run-now", {
    method: "POST",
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; result: { stats: { emailsBlocked: number }; uncollected: unknown[] } };
  expect(body.ok).toBe(true);
  expect(body.result.stats.emailsBlocked).toBe(1);
  expect(sent).toHaveLength(0);

  // GET hneď odzrkadlí manuálny beh (žiadny ďalší tick netreba čakať).
  const status = await app.request("/api/posta-uncollected", { headers: { cookie } });
  const statusBody = (await status.json()) as { lastRun: { result: { uncollected: unknown[] } } | null };
  expect(statusBody.lastRun?.result.uncollected).toHaveLength(1);
});

it("s BCC adresou 'Spustiť teraz' pošle e-mail zákazníkovi", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent, bccEmail: "majitel@forestshop.sk" });
  await db.insert(orders).values({
    externalOrderId: "20600002",
    customerName: "Test",
    statusName: "Vybavená",
    placedAt: new Date("2026-07-25T00:00:00Z"),
    email: "zakaznik@example.sk",
    packageNumber: "EF2SK",
    shippingCarrierName: "Kuriér",
  });

  await app.request("/api/posta-uncollected/run-now", { method: "POST", headers: { cookie } });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.bcc).toBe("majitel@forestshop.sk");
});

it("náhľad e-mailu (preview) vráti presne to, čo by odišlo — bez odoslania", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent, bccEmail: "majitel@forestshop.sk" });
  await db.insert(orders).values({
    externalOrderId: "20600003",
    customerName: "Zákazník Testovací",
    statusName: "Vybavená",
    placedAt: new Date("2026-07-25T00:00:00Z"),
    email: "zakaznik@example.sk",
    packageNumber: "EF3SK",
    shippingCarrierName: "Kuriér",
  });
  await app.request("/api/posta-uncollected/run-now", { method: "POST", headers: { cookie } });
  expect(sent).toHaveLength(1); // prvý e-mail sa reálne poslal

  const preview = await app.request("/api/posta-uncollected/preview/EF3SK", { headers: { cookie } });
  expect(preview.status).toBe(200);
  const body = (await preview.json()) as { ok: boolean; count: number; alreadySent: number; subject: string };
  expect(body.ok).toBe(true);
  expect(body.alreadySent).toBe(1);
  expect(body.count).toBe(2); // ĎALŠÍ e-mail (2.), nie ten istý znova
  expect(body.subject).toContain("Pripomienka");
  // Náhľad NIKDY neposlal ďalší e-mail.
  expect(sent).toHaveLength(1);
});

it("náhľad neexistujúceho čísla zásielky vráti 200 {ok:false} (bežný doménový výsledok, nikdy 4xx)", async () => {
  const { app, cookie } = await boot("manazer");
  const res = await app.request("/api/posta-uncollected/preview/NEEXISTUJE", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(false);
});
