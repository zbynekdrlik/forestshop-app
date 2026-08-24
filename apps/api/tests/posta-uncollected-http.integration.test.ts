import { afterEach, expect, it } from "vitest";
import { orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import type { MailMessage } from "../src/modules/mail/transport.js";
import { POSTA_UNCOLLECTED_JOB_NAME } from "../src/modules/scheduler/jobs.js";
import { withCleanDb } from "./helpers/db.js";
import { waitForJobRunSettled } from "./helpers/job-run.js";

// issue 172: HTTP vrstva pre "Nevyzdvihnuté zásielky". Falošný tracking klient
// + falošný mail transport — NIKDY skutočné api.posta.sk ani skutočný SMTP
// (ticket's bezpečnostná podmienka pre testy).
const HESLO = "test-heslo-abc";

// issue 480 (test robustnosť): `run-now` používa REÁLNy `new Date()` a filtruje
// objednávky 30-dňovým oknom (`SOURCE_WINDOW_DAYS`, `isEligibleOrder`). Fixtúry
// mali natvrdo `placedAt: 2026-07-25`, čo 30. dňa po tomto dátume (kalendár
// prekročil 2026-08-24) VYPADLO z okna → `run-now` nenašiel žiadnu objednávku a
// 4 testy padli („expected 1 e-mail, got 0"). Dátum je preto RELATÍVNY k teraz
// (10 dní dozadu — bezpečne v okne bez ohľadu na reálny kalendár), rovnaký
// princíp ako `logic.test.ts`, ktorý si referenčný dátum tiež riadi sám.
function placedRecently(): Date {
  return new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
}

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

// issue 413: run-now je odteraz ASYNC — POST vráti 202 HNEĎ (beh pokračuje
// na pozadí), výsledok sa overuje AŽ po dobehnutí (`waitForJobRunSettled`),
// nie priamo z POST odpovede.
it("'Spustiť teraz' funguje BEZ ohľadu na enabled=false, ale bez BCC neposlé nič", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent });
  await db.insert(orders).values({
    externalOrderId: "20600001",
    customerName: "Test",
    statusName: "Vybavená",
    placedAt: placedRecently(),
    email: "zakaznik@example.sk",
    packageNumber: "EF1SK",
    shippingCarrierName: "Kuriér",
  });

  const res = await app.request("/api/posta-uncollected/run-now", {
    method: "POST",
    headers: { cookie },
  });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { ok: boolean; started: boolean };
  expect(body).toEqual({ ok: true, started: true });

  const finished = await waitForJobRunSettled(db, POSTA_UNCOLLECTED_JOB_NAME);
  expect(finished.status).toBe("success");
  const detail = finished.detail as { stats: { emailsBlocked: number } };
  expect(detail.stats.emailsBlocked).toBe(1);
  expect(sent).toHaveLength(0);

  // GET odzrkadlí manuálny beh AKO DOBEHNUTÝ (žiadny ďalší tick netreba čakať).
  const status = await app.request("/api/posta-uncollected", { headers: { cookie } });
  const statusBody = (await status.json()) as { lastRun: { result: { uncollected: unknown[] } } | null };
  expect(statusBody.lastRun?.result.uncollected).toHaveLength(1);
});

it("'Spustiť teraz' druhý raz PRESNE počas prebiehajúceho behu vráti 200 'beh už prebieha' (žiadny duplicitný e-mail)", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent, bccEmail: "majitel@forestshop.sk" });
  await db.insert(orders).values({
    externalOrderId: "20600004",
    customerName: "Test",
    statusName: "Vybavená",
    placedAt: placedRecently(),
    email: "zakaznik@example.sk",
    packageNumber: "EF4SK",
    shippingCarrierName: "Kuriér",
  });

  const first = app.request("/api/posta-uncollected/run-now", { method: "POST", headers: { cookie } });
  // Druhý pokus IHNEĎ, bez čakania na prvý — advisory zámok (nie časovanie)
  // je to, čo garantuje, že tento vidí "busy", nie náhoda v poradí promises.
  const second = await app.request("/api/posta-uncollected/run-now", { method: "POST", headers: { cookie } });
  expect(second.status).toBe(200);
  const secondBody = (await second.json()) as { error: string };
  expect(secondBody.error).toContain("Beh už prebieha");

  const firstResponse = await first;
  expect(firstResponse.status).toBe(202);

  await waitForJobRunSettled(db, POSTA_UNCOLLECTED_JOB_NAME);
  // Presne JEDEN e-mail sa poslal — druhý (odmietnutý) pokus nikdy nespustil
  // vlastný beh, takže nikdy nemohol poslať duplicitný e-mail (issue 402's
  // pôvodný nález, kde CF retry spôsobil práve toto).
  expect(sent).toHaveLength(1);
});

it("s BCC adresou 'Spustiť teraz' pošle e-mail zákazníkovi", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent, bccEmail: "majitel@forestshop.sk" });
  await db.insert(orders).values({
    externalOrderId: "20600002",
    customerName: "Test",
    statusName: "Vybavená",
    placedAt: placedRecently(),
    email: "zakaznik@example.sk",
    packageNumber: "EF2SK",
    shippingCarrierName: "Kuriér",
  });

  await app.request("/api/posta-uncollected/run-now", { method: "POST", headers: { cookie } });
  await waitForJobRunSettled(db, POSTA_UNCOLLECTED_JOB_NAME);
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
    placedAt: placedRecently(),
    email: "zakaznik@example.sk",
    packageNumber: "EF3SK",
    shippingCarrierName: "Kuriér",
  });
  await app.request("/api/posta-uncollected/run-now", { method: "POST", headers: { cookie } });
  await waitForJobRunSettled(db, POSTA_UNCOLLECTED_JOB_NAME);
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
