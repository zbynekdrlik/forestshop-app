import { afterEach, expect, it } from "vitest";
import { mailLog, orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import type { MailMessage } from "../src/modules/mail/transport.js";
import { DEFAULT_ORDER_OPEN_STATUS } from "../src/modules/orders/open-statuses.js";
import { withCleanDb } from "./helpers/db.js";

// issue 500/502: HTTP vrstva ručného e-mailu zákazníkovi z riadku „Na
// objednanie"/„Riešiť". Falošný mail transport — NIKDY skutočný SMTP (rovnaká
// majiteľova bezpečnostná podmienka ako `order-merge-http.integration.test.ts`).
// `findCustomerContactContext` číta VÝHRADNE tabuľku `orders` podľa
// `externalOrderId`, takže žiadny `order_line`/variant fixtúra tu netreba.
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
    orderCustomerContact: {
      mailTransport:
        options.sent === undefined
          ? undefined
          : (m: MailMessage) => {
              options.sent?.push(m);
              return Promise.resolve();
            },
      bccEmail: options.bccEmail,
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

async function seedOrder(
  db: Awaited<ReturnType<typeof boot>>["db"],
  externalOrderId: string,
  options: { readonly customerName?: string; readonly email?: string | null } = {},
): Promise<void> {
  await db.insert(orders).values({
    externalOrderId,
    customerName: options.customerName ?? "Zákazník Test",
    email: options.email === undefined ? "zakaznik@example.sk" : options.email,
    statusName: DEFAULT_ORDER_OPEN_STATUS,
    placedAt: new Date("2026-08-20T10:00:00Z"),
  });
}

async function preview(app: Awaited<ReturnType<typeof boot>>["app"], cookie: string, orderCode: string) {
  return app.request("/api/order-customer-contact/preview", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode }),
  });
}

it("náhľad bez prihlásenia vráti 401", async () => {
  const { app } = await boot("manazer");
  const res = await app.request("/api/order-customer-contact/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "9401" }),
  });
  expect(res.status).toBe(401);
});

it("neznáma objednávka vráti 200 { ok:false } (nikdy 4xx — konzolové pravidlo)", async () => {
  const { app, cookie } = await boot("citanie");
  const res = await preview(app, cookie, "neexistuje");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(false);
});

it("náhľad predvyplní meno + číslo objednávky a vydá token; odoslanie bez tokenu zlyhá, s tokenom uspeje a zapíše do Knihy; token je jednorazový", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent, bccEmail: "majitel@forestshop.sk" });
  await seedOrder(db, "9401", { customerName: "Alfa Zákazník", email: "alfa@example.sk" });

  const previewRes = await preview(app, cookie, "9401");
  expect(previewRes.status).toBe(200);
  const previewBody = (await previewRes.json()) as {
    ok: boolean;
    subject: string;
    text: string;
    recipient: string;
    customerName: string;
    previewToken: string;
  };
  expect(previewBody.ok).toBe(true);
  expect(previewBody.recipient).toBe("alfa@example.sk");
  expect(previewBody.customerName).toBe("Alfa Zákazník");
  expect(previewBody.subject).toContain("9401");
  expect(previewBody.text).toContain("Alfa Zákazník");
  expect(previewBody.text).toContain("9401");

  // Odoslanie BEZ platného tokenu zlyhá — server-side vynútenie náhľadu.
  const sendBezTokenu = await app.request("/api/order-customer-contact/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "9401", previewToken: "invalid" }),
  });
  const bezTokenuBody = (await sendBezTokenu.json()) as { ok: boolean };
  expect(bezTokenuBody.ok).toBe(false);
  expect(sent).toHaveLength(0);

  // Odoslanie SO správnym tokenom uspeje.
  const sendRes = await app.request("/api/order-customer-contact/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "9401", previewToken: previewBody.previewToken }),
  });
  const sendBody = (await sendRes.json()) as { ok: boolean };
  expect(sendBody.ok).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe("alfa@example.sk");
  expect(sent[0]?.bcc).toBe("majitel@forestshop.sk");

  const logRows = await db.select({ source: mailLog.source, recipient: mailLog.recipient }).from(mailLog);
  expect(logRows).toHaveLength(1);
  expect(logRows[0]?.source).toBe("order_customer_contact");
  expect(logRows[0]?.recipient).toBe("alfa@example.sk");

  // Ten istý token DRUHÝKRÁT (jednorazová spotreba) zlyhá.
  const druhe = await app.request("/api/order-customer-contact/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "9401", previewToken: previewBody.previewToken }),
  });
  const druheBody = (await druhe.json()) as { ok: boolean };
  expect(druheBody.ok).toBe(false);
  expect(sent).toHaveLength(1);
});

it("ručne upravené telo (editedBody) sa odošle PRESNE takto (predmet ostáva pôvodný)", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent, bccEmail: "majitel@forestshop.sk" });
  await seedOrder(db, "9402", { customerName: "Beta Zákazník", email: "beta@example.sk" });

  const previewBody = (await (await preview(app, cookie, "9402")).json()) as { subject: string; previewToken: string };
  const edited = "Dobrý deň, Beta Zákazník,\n\nMáme pre Vás špeciálnu ponuku k objednávke 9402.\n\nS pozdravom";
  const sendRes = await app.request("/api/order-customer-contact/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "9402", previewToken: previewBody.previewToken, editedBody: edited }),
  });
  expect(((await sendRes.json()) as { ok: boolean }).ok).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.text).toContain("špeciálnu ponuku");
  // Predmet sa ručnou úpravou tela NIKDY nemení.
  expect(sent[0]?.subject).toBe(previewBody.subject);
});

it("fail-closed: bez BCC adresy sa NEPOŠLE nič (zapíše sa preskočenie)", async () => {
  const sent: MailMessage[] = [];
  // sent transport JE, ale bccEmail chýba → not_configured.
  const { app, cookie, db } = await boot("manazer", { sent });
  await seedOrder(db, "9403", { customerName: "Gama Zákazník", email: "gama@example.sk" });

  const previewBody = (await (await preview(app, cookie, "9403")).json()) as { previewToken: string };
  const sendRes = await app.request("/api/order-customer-contact/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "9403", previewToken: previewBody.previewToken }),
  });
  expect(((await sendRes.json()) as { ok: boolean }).ok).toBe(false);
  expect(sent).toHaveLength(0);
  const skipped = await db.select({ status: mailLog.status, source: mailLog.source }).from(mailLog);
  expect(skipped).toHaveLength(1);
  expect(skipped[0]?.status).toBe("skipped");
  expect(skipped[0]?.source).toBe("order_customer_contact");
});

it("objednávka bez e-mailu zákazníka sa NEPOŠLE (no_email)", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent, bccEmail: "majitel@forestshop.sk" });
  await seedOrder(db, "9404", { customerName: "Delta Bez Emailu", email: null });

  const previewBody = (await (await preview(app, cookie, "9404")).json()) as { recipient: string; previewToken: string };
  expect(previewBody.recipient).toBe("");
  const sendRes = await app.request("/api/order-customer-contact/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "9404", previewToken: previewBody.previewToken }),
  });
  expect(((await sendRes.json()) as { ok: boolean }).ok).toBe(false);
  expect(sent).toHaveLength(0);
});

it("rola citanie NESMIE odoslať (403) — náhľad áno, odosielanie len admin/manazer", async () => {
  const { app, cookie, db } = await boot("citanie", { sent: [], bccEmail: "majitel@forestshop.sk" });
  await seedOrder(db, "9405", { customerName: "Zeta Zákazník", email: "zeta@example.sk" });

  const previewBody = (await (await preview(app, cookie, "9405")).json()) as { ok: boolean; previewToken: string };
  expect(previewBody.ok).toBe(true);

  const res = await app.request("/api/order-customer-contact/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "9405", previewToken: previewBody.previewToken }),
  });
  expect(res.status).toBe(403);
});
