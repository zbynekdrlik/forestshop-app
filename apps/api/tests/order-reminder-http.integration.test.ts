import { afterEach, expect, it } from "vitest";
import { orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import type { MailMessage } from "../src/modules/mail/transport.js";
import { ORDER_REMINDER_JOB_NAME } from "../src/modules/scheduler/jobs.js";
import { withCleanDb } from "./helpers/db.js";
import { waitForJobRunSettled } from "./helpers/job-run.js";

// issue 173: HTTP vrstva pre "Pripomienky objednávok". Falošný AI
// klasifikátor + falošný mail transport — NIKDY skutočné OpenAI ani
// skutočný SMTP (majiteľova bezpečnostná podmienka pre testy).
const HESLO = "test-heslo-abc";
const OLD_ENOUGH = new Date("2026-07-25T00:00:00Z");

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot(
  role: UserRole,
  options: { readonly sent?: MailMessage[]; readonly bccEmail?: string; readonly contacted?: boolean } = {},
) {
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
    orderReminder: {
      classifyClient: () => Promise.resolve(options.contacted ?? false),
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
  const res = await app.request("/api/order-reminder");
  expect(res.status).toBe(401);
});

it("GET vráti enabled=false hneď po migrácii (bezpečný default)", async () => {
  const { app, cookie } = await boot("citanie");
  const res = await app.request("/api/order-reminder", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { enabled: boolean; lastRun: unknown };
  expect(body.enabled).toBe(false);
  expect(body.lastRun).toBeNull();
});

it("rola citanie NESMIE prepnúť Štart/Stop (403)", async () => {
  const { app, cookie } = await boot("citanie");
  const res = await app.request("/api/order-reminder/enabled", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(res.status).toBe(403);
});

it("manazer prepne Štart/Stop a GET to hneď odzrkadlí", async () => {
  const { app, cookie } = await boot("manazer");
  const put = await app.request("/api/order-reminder/enabled", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(put.status).toBe(200);

  const res = await app.request("/api/order-reminder", { headers: { cookie } });
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
    externalOrderId: "20600101",
    customerName: "Test Zákazník",
    statusName: "Vybavuje sa",
    placedAt: OLD_ENOUGH,
    email: "zakaznik@example.sk",
    shopRemark: "volať zákazníka",
  });

  const res = await app.request("/api/order-reminder/run-now", { method: "POST", headers: { cookie } });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { ok: boolean; started: boolean };
  expect(body).toEqual({ ok: true, started: true });

  const finished = await waitForJobRunSettled(db, ORDER_REMINDER_JOB_NAME);
  expect(finished.status).toBe("success");
  const detail = finished.detail as { pending: unknown[] };
  expect(detail.pending).toHaveLength(1); // chýba BCC → čaká
  expect(sent).toHaveLength(0);

  const status = await app.request("/api/order-reminder", { headers: { cookie } });
  const statusBody = (await status.json()) as { lastRun: { result: { pending: unknown[] } } | null };
  expect(statusBody.lastRun?.result.pending).toHaveLength(1);
});

it("'Spustiť teraz' druhý raz PRESNE počas prebiehajúceho behu vráti 200 'beh už prebieha'", async () => {
  const { app, cookie, db } = await boot("manazer");

  const first = app.request("/api/order-reminder/run-now", { method: "POST", headers: { cookie } });
  const second = await app.request("/api/order-reminder/run-now", { method: "POST", headers: { cookie } });
  expect(second.status).toBe(200);
  const secondBody = (await second.json()) as { error: string };
  expect(secondBody.error).toContain("Beh už prebieha");

  const firstResponse = await first;
  expect(firstResponse.status).toBe(202);
  await waitForJobRunSettled(db, ORDER_REMINDER_JOB_NAME);
});

it("s BCC adresou 'Spustiť teraz' pošle e-mail zákazníkovi", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent, bccEmail: "majitel@forestshop.sk", contacted: false });
  await db.insert(orders).values({
    externalOrderId: "20600102",
    customerName: "Test",
    statusName: "Vybavuje sa",
    placedAt: OLD_ENOUGH,
    email: "zakaznik@example.sk",
    shopRemark: "volať zákazníka",
  });

  await app.request("/api/order-reminder/run-now", { method: "POST", headers: { cookie } });
  await waitForJobRunSettled(db, ORDER_REMINDER_JOB_NAME);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.bcc).toBe("majitel@forestshop.sk");
});

it("náhľad e-mailu (preview) vráti presne to, čo by odišlo — bez odoslania", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent, bccEmail: "majitel@forestshop.sk", contacted: false });
  await db.insert(orders).values({
    externalOrderId: "20600103",
    customerName: "Zákazník Testovací",
    statusName: "Vybavuje sa",
    placedAt: OLD_ENOUGH,
    email: "zakaznik@example.sk",
    shopRemark: "volať zákazníka",
  });
  await app.request("/api/order-reminder/run-now", { method: "POST", headers: { cookie } });
  await waitForJobRunSettled(db, ORDER_REMINDER_JOB_NAME);
  expect(sent).toHaveLength(1);

  const preview = await app.request("/api/order-reminder/preview/20600103", { headers: { cookie } });
  expect(preview.status).toBe(200);
  const body = (await preview.json()) as { ok: boolean; subject: string; recipient: string };
  expect(body.ok).toBe(true);
  expect(body.subject).toContain("Forestshop.sk");
  expect(body.recipient).toBe("zakaznik@example.sk");
  expect(sent).toHaveLength(1); // náhľad neposlal ďalší e-mail
});

it("náhľad neexistujúceho kódu objednávky vráti 200 {ok:false} (bežný doménový výsledok, nikdy 4xx)", async () => {
  const { app, cookie } = await boot("manazer");
  const res = await app.request("/api/order-reminder/preview/NEEXISTUJE", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(false);
});

it("ručná akcia 'kontaktované' (override) funguje aj pri enabled=false", async () => {
  const { app, cookie, db } = await boot("manazer");
  await db.insert(orders).values({
    externalOrderId: "20600104",
    customerName: "Test",
    statusName: "Vybavuje sa",
    placedAt: OLD_ENOUGH,
    email: "zakaznik@example.sk",
    shopRemark: null,
  });
  const res = await app.request("/api/order-reminder/override", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "20600104", action: "contact" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; resolution: string };
  expect(body.ok).toBe(true);
  expect(body.resolution).toBe("contacted");
});

it("rola citanie NESMIE poslať ručnú akciu (403)", async () => {
  const { app, cookie, db } = await boot("citanie");
  await db.insert(orders).values({
    externalOrderId: "20600105",
    customerName: "Test",
    statusName: "Vybavuje sa",
    placedAt: OLD_ENOUGH,
    email: "zakaznik@example.sk",
    shopRemark: null,
  });
  const res = await app.request("/api/order-reminder/override", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "20600105", action: "contact" }),
  });
  expect(res.status).toBe(403);
});

it("ručná akcia 'kontaktované' PRESUNIE riadok z 'bez poznámky' do 'preskočené' v NASLEDUJÚCOM GET (bez čakania na ďalší beh)", async () => {
  const { app, cookie, db } = await boot("manazer");
  await db.insert(orders).values({
    externalOrderId: "20600106",
    customerName: "Test Presun",
    statusName: "Vybavuje sa",
    placedAt: OLD_ENOUGH,
    email: null,
    shopRemark: null,
  });
  await app.request("/api/order-reminder/run-now", { method: "POST", headers: { cookie } });
  await waitForJobRunSettled(db, ORDER_REMINDER_JOB_NAME);
  const before = await app.request("/api/order-reminder", { headers: { cookie } });
  const beforeBody = (await before.json()) as { lastRun: { result: { noNote: { orderCode: string }[] } } | null };
  expect(beforeBody.lastRun?.result.noNote.map((r) => r.orderCode)).toContain("20600106");

  const override = await app.request("/api/order-reminder/override", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "20600106", action: "contact" }),
  });
  expect(override.status).toBe(200);

  const after = await app.request("/api/order-reminder", { headers: { cookie } });
  const afterBody = (await after.json()) as {
    lastRun: { result: { noNote: { orderCode: string }[]; contacted: { orderCode: string; resolvedBy: string }[] } } | null;
  };
  expect(afterBody.lastRun?.result.noNote.map((r) => r.orderCode)).not.toContain("20600106");
  const relocated = afterBody.lastRun?.result.contacted.find((r) => r.orderCode === "20600106");
  expect(relocated?.resolvedBy).toBe("manual");
});

it("ručná akcia na neznámy kód objednávky vráti 200 {ok:false} (bežný doménový výsledok)", async () => {
  const { app, cookie } = await boot("manazer");
  const res = await app.request("/api/order-reminder/override", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "NEEXISTUJE", action: "contact" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(false);
});
