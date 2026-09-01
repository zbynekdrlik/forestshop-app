import { eq } from "drizzle-orm";
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

// issue 176 (code review pred mergom, PR #182): `/send` vyžaduje token vydaný
// `/preview` — tento helper zavolá náhľad a vráti jeho token, presne to, čo
// skutočný frontend robí PRED odoslaním.
async function previewToken(
  app: Awaited<ReturnType<typeof boot>>["app"],
  cookie: string,
  orderCode: string,
  variantCode: string,
  emailType = "nedostupne",
): Promise<string> {
  const res = await app.request("/api/nedostupne/preview", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode, variantCode, emailType }),
  });
  const body = (await res.json()) as { ok: boolean; previewToken: string };
  if (!body.ok) throw new Error("náhľad zlyhal v test helperi");
  return body.previewToken;
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

// issue 529: GET vracia `orderId` (interné id objednávky, potrebné pre zápis
// poznámky cez `PUT /api/orders/:id/comment`) a aktuálnu `comment` (predvyplní
// vstup poznámky), aby ju obsluha vedela upraviť, nie prepísať naslepo.
it("GET vracia orderId a aktuálnu poznámku objednávky (issue 529)", async () => {
  const { app, cookie, db } = await boot("citanie");
  await seedNedostupneLine(db, "17601010", "N176CMT");
  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.externalOrderId, "17601010"));
  if (order === undefined) throw new Error("test objednávka sa nenašla");
  await db.update(orders).set({ comment: "objednané u dodávateľa" }).where(eq(orders.id, order.id));

  const res = await app.request("/api/nedostupne", { headers: { cookie } });
  const body = (await res.json()) as { groups: { orders: { orderId: string; comment: string | null }[] }[] };
  expect(body.groups[0]?.orders[0]?.orderId).toBe(order.id);
  expect(body.groups[0]?.orders[0]?.comment).toBe("objednané u dodávateľa");
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
  const token = await previewToken(app, cookie, "17601003", "N176C");
  const res = await app.request("/api/nedostupne/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "17601003", variantCode: "N176C", emailType: "nedostupne", previewToken: token }),
  });
  expect(res.status).toBe(403);
});

it("manazer odošle e-mail, GET hneď odzrkadlí 'nedostupneSent: true'", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent, bccEmail: "majitel@forestshop.sk" });
  await seedNedostupneLine(db, "17601004", "N176D");
  const token = await previewToken(app, cookie, "17601004", "N176D");

  const send = await app.request("/api/nedostupne/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "17601004", variantCode: "N176D", emailType: "nedostupne", previewToken: token }),
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
  const bodyBase = { orderCode: "17601005", variantCode: "N176E", emailType: "nedostupne" };

  const token1 = await previewToken(app, cookie, "17601005", "N176E");
  await app.request("/api/nedostupne/send", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ ...bodyBase, previewToken: token1 }) });
  expect(sent).toHaveLength(1);

  const token2 = await previewToken(app, cookie, "17601005", "N176E");
  const second = await app.request("/api/nedostupne/send", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ ...bodyBase, previewToken: token2 }) });
  expect(second.status).toBe(200);
  const secondBody = (await second.json()) as { ok: boolean; error: string };
  expect(secondBody.ok).toBe(false);
  expect(secondBody.error).toContain("už bol");
  expect(sent).toHaveLength(1);
});

// issue 176 (code review pred mergom, PR #182) — server-side vynútenie
// povinného náhľadu: `/send` bez volania `/preview` PRE PRESNE tento
// (objednávka, variant, typ) sa VŽDY odmietne, žiadny e-mail sa nepošle.
it("odoslanie BEZ predchádzajúceho náhľadu je odmietnuté — žiadny token, žiadny e-mail", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent, bccEmail: "majitel@forestshop.sk" });
  await seedNedostupneLine(db, "17601006", "N176F");

  const res = await app.request("/api/nedostupne/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "17601006", variantCode: "N176F", emailType: "nedostupne", previewToken: "vymyslený-token" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; error: string };
  expect(body.ok).toBe(false);
  expect(body.error).toContain("náhľad");
  expect(sent).toHaveLength(0);
});

it("token vydaný pre INÝ (objednávka/variant/typ) sa na tento send NEDÁ použiť", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent, bccEmail: "majitel@forestshop.sk" });
  await seedNedostupneLine(db, "17601007", "N176G");
  await seedNedostupneLine(db, "17601008", "N176H");

  const tokenForOther = await previewToken(app, cookie, "17601008", "N176H");
  const res = await app.request("/api/nedostupne/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "17601007", variantCode: "N176G", emailType: "nedostupne", previewToken: tokenForOther }),
  });
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(false);
  expect(sent).toHaveLength(0);
});

it("token je JEDNORAZOVÝ — druhé odoslanie s TÝM ISTÝM tokenom (iný typ) je odmietnuté, aj keby dedup inak dovolil", async () => {
  const sent: MailMessage[] = [];
  const { app, cookie, db } = await boot("manazer", { sent, bccEmail: "majitel@forestshop.sk" });
  await seedNedostupneLine(db, "17601009", "N176I");
  const token = await previewToken(app, cookie, "17601009", "N176I");
  const body = { orderCode: "17601009", variantCode: "N176I", emailType: "nedostupne", previewToken: token };

  const first = await app.request("/api/nedostupne/send", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await first.json()) as { ok: boolean }).toMatchObject({ ok: true });

  // Znovu POUŽITÝ token (žiadny nový náhľad) na iný typ e-mailu — token je
  // už skonzumovaný, nesmie fungovať znova ani na iný (inak by prešiel) typ.
  const secondBody = { ...body, emailType: "alternativa" };
  const second = await app.request("/api/nedostupne/send", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(secondBody) });
  const secondJson = (await second.json()) as { ok: boolean };
  expect(secondJson.ok).toBe(false);
  expect(sent).toHaveLength(1);
});

// issue 238: majiteľove RUČNE vložené odkazy náhrad — nahrádza pôvodný
// automatický `product.relatedCodes` návrh.

it("manazer pridá ručný odkaz náhrady — hneď vidno v GET zozname, viac odkazov na ten istý variant funguje", async () => {
  const { app, cookie, db } = await boot("manazer");
  await seedNedostupneLine(db, "17601010", "N176J");

  const first = await app.request("/api/nedostupne/replacement-links", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "N176J", url: "https://www.forestshop.sk/prvy/" }),
  });
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as { ok: boolean; link: { id: string; url: string } };
  expect(firstBody.ok).toBe(true);
  expect(firstBody.link.url).toBe("https://www.forestshop.sk/prvy/");

  await app.request("/api/nedostupne/replacement-links", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "N176J", url: "https://www.forestshop.sk/druhy/" }),
  });

  const list = await app.request("/api/nedostupne", { headers: { cookie } });
  const listBody = (await list.json()) as { groups: { variantCode: string; replacementLinks: { id: string; url: string }[] }[] };
  const group = listBody.groups.find((g) => g.variantCode === "N176J");
  expect(group?.replacementLinks.map((l) => l.url)).toEqual(["https://www.forestshop.sk/prvy/", "https://www.forestshop.sk/druhy/"]);
});

it("rola citanie NESMIE pridať odkaz náhrady (403)", async () => {
  const { app, cookie, db } = await boot("citanie");
  await seedNedostupneLine(db, "17601011", "N176K");
  const res = await app.request("/api/nedostupne/replacement-links", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "N176K", url: "https://www.forestshop.sk/x/" }),
  });
  expect(res.status).toBe(403);
});

it("neplatná URL (nie http/https) je odmietnutá — 400", async () => {
  const { app, cookie } = await boot("manazer");
  const res = await app.request("/api/nedostupne/replacement-links", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "N176L", url: "javascript:alert(1)" }),
  });
  expect(res.status).toBe(400);
});

it("manazer zmaže odkaz náhrady — zmizne z GET zoznamu; zmazanie neznámeho id vráti ok:true, removed:false", async () => {
  const { app, cookie } = await boot("manazer");
  const add = await app.request("/api/nedostupne/replacement-links", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ variantCode: "N176M", url: "https://www.forestshop.sk/zmazat/" }),
  });
  const addBody = (await add.json()) as { link: { id: string } };

  const del = await app.request(`/api/nedostupne/replacement-links/${addBody.link.id}`, { method: "DELETE", headers: { cookie } });
  expect(del.status).toBe(200);
  expect((await del.json()) as { ok: boolean; removed: boolean }).toEqual({ ok: true, removed: true });

  const delAgain = await app.request(`/api/nedostupne/replacement-links/${addBody.link.id}`, { method: "DELETE", headers: { cookie } });
  expect((await delAgain.json()) as { ok: boolean; removed: boolean }).toEqual({ ok: true, removed: false });
});
