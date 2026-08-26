import { afterEach, expect, it } from "vitest";
import { mailLog, orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import type { MailMessage } from "../src/modules/mail/transport.js";
import { DEFAULT_ORDER_OPEN_STATUS } from "../src/modules/orders/open-statuses.js";
import { withCleanDb } from "./helpers/db.js";

// issue 257: HTTP vrstva "Zlúčenie objednávok". Falošný mail transport —
// NIKDY skutočný SMTP (rovnaká majiteľova bezpečnostná podmienka ako
// `nedostupne-http.integration.test.ts`). `listMergeCandidateGroups` číta
// VÝHRADNE tabuľku `orders`, takže žiadny `order_line`/variant fixtúra tu
// nie je potrebná.
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
    orderMerge: {
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
  options: {
    readonly customerName?: string;
    readonly email?: string | null;
    readonly statusName?: string;
    readonly placedAt?: Date;
    // issue 512: interné Shoptet id — keď je nastavené, `adminUrl` je priamy
    // odkaz `?id=`; keď null (default), vyhľadávací fallback `?string=`.
    readonly shoptetOrderId?: number;
  } = {},
): Promise<string> {
  const [order] = await db
    .insert(orders)
    .values({
      externalOrderId,
      customerName: options.customerName ?? "Zákazník Test",
      email: options.email === undefined ? "zakaznik@example.sk" : options.email,
      statusName: options.statusName ?? DEFAULT_ORDER_OPEN_STATUS,
      placedAt: options.placedAt ?? new Date("2026-07-20T10:00:00Z"),
      ...(options.shoptetOrderId === undefined ? {} : { shoptetOrderId: options.shoptetOrderId }),
    })
    .returning({ id: orders.id });
  if (order === undefined) throw new Error("test objednávka sa nepodarila vložiť");
  return order.id;
}

it("GET candidates bez prihlásenia vráti 401", async () => {
  const { app } = await boot("manazer");
  const res = await app.request("/api/order-merge/candidates");
  expect(res.status).toBe(401);
});

it("zákazník s 2 otvorenými objednávkami je kandidát, s 1 otvorenou NIE JE", async () => {
  const { app, cookie, db } = await boot("citanie");
  // Dve objednávky TOHO ISTÉHO zákazníka (zhoda podľa e-mailu) — kandidát.
  await seedOrder(db, "9101", { customerName: "Alfa Zákazník", email: "alfa@example.sk", placedAt: new Date("2026-07-20T10:00:00Z") });
  await seedOrder(db, "9102", { customerName: "Alfa Zákazník", email: "alfa@example.sk", placedAt: new Date("2026-07-21T10:00:00Z") });
  // Jedna objednávka INÉHO zákazníka — NIE kandidát (len 1 otvorená).
  await seedOrder(db, "9103", { customerName: "Beta Zákazník", email: "beta@example.sk" });

  const res = await app.request("/api/order-merge/candidates", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { groups: { customerName: string; orders: { externalOrderId: string }[] }[] };
  expect(body.groups).toHaveLength(1);
  expect(body.groups[0]?.customerName).toBe("Alfa Zákazník");
  const externalIds = (body.groups[0]?.orders ?? []).map((o) => o.externalOrderId).sort();
  expect(externalIds).toEqual(["9101", "9102"]);
});

it("objednávka MIMO otvoreného zoznamu stavov sa do zoskupenia nepočíta", async () => {
  const { app, cookie, db } = await boot("citanie");
  await seedOrder(db, "9104", { customerName: "Gama Zákazník", email: "gama@example.sk" });
  await seedOrder(db, "9105", { customerName: "Gama Zákazník", email: "gama@example.sk", statusName: "Uzavretá — mimo zoznamu" });

  const res = await app.request("/api/order-merge/candidates", { headers: { cookie } });
  const body = (await res.json()) as { groups: unknown[] };
  expect(body.groups).toHaveLength(0);
});

it("zákazník bez e-mailu sa zlučuje podľa MENA (fallback)", async () => {
  const { app, cookie, db } = await boot("citanie");
  await seedOrder(db, "9106", { customerName: "Delta Bez Emailu", email: null, placedAt: new Date("2026-07-20T10:00:00Z") });
  await seedOrder(db, "9107", { customerName: "Delta Bez Emailu", email: null, placedAt: new Date("2026-07-21T10:00:00Z") });

  const res = await app.request("/api/order-merge/candidates", { headers: { cookie } });
  const body = (await res.json()) as { groups: { customerName: string }[] };
  expect(body.groups).toHaveLength(1);
  expect(body.groups[0]?.customerName).toBe("Delta Bez Emailu");
});

it("issue 512: každá objednávka vo výpise nesie adminUrl — priamy ?id= keď je Shoptet id, inak ?string= fallback", async () => {
  const { app, cookie, db } = await boot("citanie");
  // Ten istý zákazník, dve otvorené objednávky — jedna s interným Shoptet id,
  // druhá bez neho.
  await seedOrder(db, "9201", {
    customerName: "Epsilon Zákazník",
    email: "epsilon@example.sk",
    placedAt: new Date("2026-07-21T10:00:00Z"),
    shoptetOrderId: 58656,
  });
  await seedOrder(db, "9202", {
    customerName: "Epsilon Zákazník",
    email: "epsilon@example.sk",
    placedAt: new Date("2026-07-20T10:00:00Z"),
  });

  const res = await app.request("/api/order-merge/candidates", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { groups: { orders: { externalOrderId: string; adminUrl: string }[] }[] };
  const byCode = new Map((body.groups[0]?.orders ?? []).map((o) => [o.externalOrderId, o.adminUrl]));
  expect(byCode.get("9201")).toBe("https://www.forestshop.sk/admin/objednavky-detail/?id=58656");
  expect(byCode.get("9202")).toBe("https://www.forestshop.sk/admin/vyhladavanie/?string=9202&src=orders");
});

it("issue 512: /count počíta PRÍPADY (osoby) s ≥2 otvorenými objednávkami, NIE objednávky", async () => {
  const { app, cookie, db } = await boot("citanie");
  // Alfa: 3 otvorené objednávky → 1 prípad.
  await seedOrder(db, "9211", { customerName: "Alfa", email: "alfa@example.sk" });
  await seedOrder(db, "9212", { customerName: "Alfa", email: "alfa@example.sk" });
  await seedOrder(db, "9213", { customerName: "Alfa", email: "alfa@example.sk" });
  // Gama: 2 otvorené objednávky → 1 prípad.
  await seedOrder(db, "9214", { customerName: "Gama", email: "gama@example.sk" });
  await seedOrder(db, "9215", { customerName: "Gama", email: "gama@example.sk" });
  // Beta: 1 otvorená objednávka → 0 prípadov.
  await seedOrder(db, "9216", { customerName: "Beta", email: "beta@example.sk" });

  const res = await app.request("/api/order-merge/count", { headers: { cookie } });
  expect(res.status).toBe(200);
  // 6 objednávok, ale iba 2 PRÍPADY (osoby) — Alfa a Gama; Beta sa nepočíta.
  expect((await res.json()) as { count: number }).toEqual({ count: 2 });
});

it("issue 512: GET /count bez prihlásenia vráti 401", async () => {
  const { app } = await boot("manazer");
  const res = await app.request("/api/order-merge/count");
  expect(res.status).toBe(401);
});

it("bccMissing/mailNotConfigured — bez BCC ani mail transportu", async () => {
  const { app, cookie } = await boot("citanie");
  const res = await app.request("/api/order-merge/candidates", { headers: { cookie } });
  const body = (await res.json()) as { bccMissing: boolean; mailNotConfigured: boolean };
  expect(body.bccMissing).toBe(true);
  expect(body.mailNotConfigured).toBe(true);
});

it("náhľad vráti obsah + token; odoslanie bez tokenu zlyhá; s tokenom uspeje a zapíše do Knihy odoslaných e-mailov; token je jednorazový", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent, bccEmail: "majitel@forestshop.sk" });
  const baseId = await seedOrder(db, "9201", { customerName: "Epsilon Zákazník", email: "epsilon@example.sk", placedAt: new Date("2026-07-20T10:00:00Z") });
  const otherId = await seedOrder(db, "9202", { customerName: "Epsilon Zákazník", email: "epsilon@example.sk", placedAt: new Date("2026-07-21T10:00:00Z") });

  const previewRes = await app.request("/api/order-merge/preview", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ baseOrderId: baseId, otherOrderIds: [otherId] }),
  });
  expect(previewRes.status).toBe(200);
  const previewBody = (await previewRes.json()) as { ok: boolean; previewToken: string; recipient: string; orderNumbers: string[] };
  expect(previewBody.ok).toBe(true);
  expect(previewBody.recipient).toBe("epsilon@example.sk");
  expect(previewBody.orderNumbers.sort()).toEqual(["9201", "9202"]);

  // Odoslanie BEZ tokenu (vymyslený reťazec) zlyhá — server-side vynútenie.
  const sendBezTokenu = await app.request("/api/order-merge/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ baseOrderId: baseId, otherOrderIds: [otherId], previewToken: "vymyslený-token" }),
  });
  const bezTokenuBody = (await sendBezTokenu.json()) as { ok: boolean; error: string };
  expect(bezTokenuBody.ok).toBe(false);
  expect(sent).toHaveLength(0);

  // Odoslanie SO správnym tokenom uspeje.
  const sendRes = await app.request("/api/order-merge/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ baseOrderId: baseId, otherOrderIds: [otherId], previewToken: previewBody.previewToken }),
  });
  const sendBody = (await sendRes.json()) as { ok: boolean };
  expect(sendBody.ok).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe("epsilon@example.sk");
  expect(sent[0]?.bcc).toBe("majitel@forestshop.sk");

  const logRows = await db.select({ source: mailLog.source, recipient: mailLog.recipient }).from(mailLog);
  expect(logRows).toHaveLength(1);
  expect(logRows[0]?.source).toBe("order_merge");
  expect(logRows[0]?.recipient).toBe("epsilon@example.sk");

  // Ten istý token DRUHÝKRÁT (jednorazová spotreba) zlyhá.
  const druheOdoslanie = await app.request("/api/order-merge/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ baseOrderId: baseId, otherOrderIds: [otherId], previewToken: previewBody.previewToken }),
  });
  const druheBody = (await druheOdoslanie.json()) as { ok: boolean };
  expect(druheBody.ok).toBe(false);
  expect(sent).toHaveLength(1);
});

it("rola citanie NESMIE odoslať (403) — čítanie a náhľad áno, odosielanie len admin/manazer", async () => {
  const { app, cookie, db } = await boot("citanie", { sent: [], bccEmail: "majitel@forestshop.sk" });
  const baseId = await seedOrder(db, "9301", { customerName: "Zeta Zákazník", email: "zeta@example.sk" });
  const otherId = await seedOrder(db, "9302", { customerName: "Zeta Zákazník", email: "zeta@example.sk" });

  const previewRes = await app.request("/api/order-merge/preview", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ baseOrderId: baseId, otherOrderIds: [otherId] }),
  });
  expect(previewRes.status).toBe(200);
  const previewBody = (await previewRes.json()) as { previewToken: string };

  const res = await app.request("/api/order-merge/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ baseOrderId: baseId, otherOrderIds: [otherId], previewToken: previewBody.previewToken }),
  });
  expect(res.status).toBe(403);
});
