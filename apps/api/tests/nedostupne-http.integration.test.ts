import { afterEach, expect, it } from "vitest";
import { orderLines, orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import type { MailMessage } from "../src/modules/mail/transport.js";
import { DEFAULT_ORDER_OPEN_STATUS } from "../src/modules/orders/open-statuses.js";
import { insertTestVariantForProduct } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 176: HTTP vrstva pre "Nedostupné tovary". Falošný mail transport —
// NIKDY skutočný SMTP (majiteľova bezpečnostná podmienka pre testy).
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
    nedostupne: {
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

async function seedNedostupneLine(db: Awaited<ReturnType<typeof boot>>["db"], orderCode: string, variantCode: string): Promise<void> {
  await insertTestVariantForProduct(db, `${variantCode}-key`, variantCode, { productName: `Test ${variantCode}` });
  const [order] = await db
    .insert(orders)
    .values({ externalOrderId: orderCode, customerName: "Zákazník Test", statusName: DEFAULT_ORDER_OPEN_STATUS, placedAt: new Date("2026-07-20T10:00:00Z"), email: "zakaznik@example.sk" })
    .returning({ id: orders.id });
  if (order === undefined) throw new Error("test objednávka sa nepodarilo vložiť");
  await db.insert(orderLines).values({ orderId: order.id, variantCode, quantity: 1, state: "nedostupne" });
}

it("GET bez prihlásenia vráti 401", async () => {
  const { app } = await boot("manazer");
  const res = await app.request("/api/nedostupne");
  expect(res.status).toBe(401);
});

it("GET vráti prázdny zoznam + upozornenia na chýbajúcu BCC/mail konfiguráciu", async () => {
  const { app, cookie } = await boot("citanie");
  const res = await app.request("/api/nedostupne", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { groups: unknown[]; bccMissing: boolean; mailNotConfigured: boolean };
  expect(body.groups).toEqual([]);
  expect(body.bccMissing).toBe(true);
  expect(body.mailNotConfigured).toBe(true);
});

it("GET vráti nedostupný riadok zoskupený podľa variantu, spárovaný s objednávkou", async () => {
  const { app, cookie, db } = await boot("citanie");
  await seedNedostupneLine(db, "17601001", "N176A");

  const res = await app.request("/api/nedostupne", { headers: { cookie } });
  const body = (await res.json()) as { groups: { variantCode: string; orders: { orderCode: string }[] }[] };
  expect(body.groups).toHaveLength(1);
  expect(body.groups[0]?.variantCode).toBe("N176A");
  expect(body.groups[0]?.orders[0]?.orderCode).toBe("17601001");
});

it("náhľad vráti presne to, čo by sa odoslalo — bez odoslania", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("citanie", { sent, bccEmail: "majitel@forestshop.sk" });
  await seedNedostupneLine(db, "17601002", "N176B");

  const preview = await app.request("/api/nedostupne/preview", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "17601002", variantCode: "N176B", emailType: "nedostupne" }),
  });
  expect(preview.status).toBe(200);
  const body = (await preview.json()) as { ok: boolean; subject: string; recipient: string };
  expect(body.ok).toBe(true);
  expect(body.subject).toContain("Forestshop.sk");
  expect(body.recipient).toBe("zakaznik@example.sk");
  expect(sent).toHaveLength(0);
});

it("náhľad neexistujúceho riadku vráti 200 {ok:false} (nikdy 4xx, `.claude/rules/testing.md`'s console pravidlo)", async () => {
  const { app, cookie } = await boot("citanie");
  const res = await app.request("/api/nedostupne/preview", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "NEEXISTUJE", variantCode: "X", emailType: "nedostupne" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(false);
});

it("rola citanie NESMIE odoslať (403) — čítanie áno, odosielanie len admin/manazer", async () => {
  const { app, cookie, db } = await boot("citanie", { sent: [], bccEmail: "majitel@forestshop.sk" });
  await seedNedostupneLine(db, "17601003", "N176C");
  const res = await app.request("/api/nedostupne/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "17601003", variantCode: "N176C", emailType: "nedostupne" }),
  });
  expect(res.status).toBe(403);
});

it("manazer odošle e-mail, GET hneď odzrkadlí 'nedostupneSent: true'", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent, bccEmail: "majitel@forestshop.sk" });
  await seedNedostupneLine(db, "17601004", "N176D");

  const send = await app.request("/api/nedostupne/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "17601004", variantCode: "N176D", emailType: "nedostupne" }),
  });
  expect(send.status).toBe(200);
  const sendBody = (await send.json()) as { ok: boolean };
  expect(sendBody.ok).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.bcc).toBe("majitel@forestshop.sk");

  const list = await app.request("/api/nedostupne", { headers: { cookie } });
  const listBody = (await list.json()) as { groups: { orders: { nedostupneSent: boolean }[] }[] };
  expect(listBody.groups[0]?.orders[0]?.nedostupneSent).toBe(true);
});

it("druhé odoslanie ROVNAKÉHO e-mailu je odmietnuté 200 {ok:false} (dedup)", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent, bccEmail: "majitel@forestshop.sk" });
  await seedNedostupneLine(db, "17601005", "N176E");
  const body = { orderCode: "17601005", variantCode: "N176E", emailType: "nedostupne" };

  await app.request("/api/nedostupne/send", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(sent).toHaveLength(1);

  const second = await app.request("/api/nedostupne/send", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(second.status).toBe(200);
  const secondBody = (await second.json()) as { ok: boolean; error: string };
  expect(secondBody.ok).toBe(false);
  expect(secondBody.error).toContain("už bol");
  expect(sent).toHaveLength(1);
});
