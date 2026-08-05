import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { mailLog, mailTemplates, orderLines, orders, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { MailMessage } from "../src/modules/mail/transport.js";
import { sendOrderMergeMail } from "../src/modules/orders/merge-mail.js";
import { DEFAULT_ORDER_OPEN_STATUS } from "../src/modules/orders/open-statuses.js";
import { sendNedostupneEmail } from "../src/modules/nedostupne/send.js";
import { saveTemplate } from "../src/modules/mail-templates/store.js";
import { insertTestVariantForProduct } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 277: jednorazová RUČNÁ úprava textu tesne pred odoslaním (okno
// náhľadu) — appka MUSÍ odoslať presne to, čo obsluha upravila (nie znova
// vygenerovanú šablónu), zapísať TO ISTÉ do Knihy odoslaných e-mailov, a
// šablóna v `mail_template` musí po odoslaní ostať bajt na bajt nezmenená.
// Falošný mail transport — nikdy skutočný SMTP (majiteľova podmienka).

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function boot() {
  const ctx = await withCleanDb();
  close = ctx.close;
  return ctx.db;
}

function fakeMail(): { readonly transport: (m: MailMessage) => Promise<void>; readonly sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    transport: (m) => {
      sent.push(m);
      return Promise.resolve();
    },
    sent,
  };
}

it("nedostupne: editedBody nahradí vygenerované znenie, šablóna ostáva nezmenená, Kniha uloží upravený text", async () => {
  const db = await boot();
  await insertTestVariantForProduct(db, "P277A", "P277A", { productName: "Nohavice Test" });
  const [order] = await db
    .insert(orders)
    .values({ externalOrderId: "27700001", customerName: "Ján Novák", statusName: DEFAULT_ORDER_OPEN_STATUS, placedAt: new Date("2026-08-01T10:00:00Z"), email: "jan@example.sk" })
    .returning({ id: orders.id });
  if (order === undefined) throw new Error("test objednávka sa nepodarilo vložiť");
  await db.insert(orderLines).values({ orderId: order.id, variantCode: "P277A", quantity: 1, state: "nedostupne" });

  // Majiteľ si predtým prispôsobil šablónu — musí ostať PRESNE takáto po
  // odoslaní s ručne upraveným textom (dôkaz, že editácia nikdy nezapisuje
  // do `mail_template`).
  const now = new Date("2026-08-01T11:00:00Z");
  const actorId = await seedActor(db);
  const saved = await saveTemplate(db, {
    key: "nedostupne",
    subject: "Vlastný predmet — {{meno_zakaznika}}",
    body: "Vlastné znenie pre {{meno_zakaznika}}.",
    userId: actorId,
    now,
  });
  expect(saved.ok).toBe(true);
  const beforeSend = (await db.select().from(mailTemplates).where(eq(mailTemplates.key, "nedostupne")))[0];
  if (beforeSend === undefined) throw new Error("šablóna sa nepodarilo uložiť pred testom");

  const { transport, sent } = fakeMail();
  const editedText = "Dobrý deň, Ján,\n\nváš tovar bohužiaľ nemáme skladom — ospravedlňujeme sa a hľadáme náhradu.\n\nS pozdravom, obchod";
  const result = await sendNedostupneEmail({
    db,
    now: new Date("2026-08-01T12:00:00Z"),
    orderCode: "27700001",
    variantCode: "P277A",
    emailType: "nedostupne",
    mailTransport: transport,
    bccEmail: "majitel@forestshop.sk",
    editedBody: editedText,
  });
  expect(result).toEqual({ ok: true });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.text).toBe(editedText);
  expect(sent[0]?.html).toContain("váš tovar bohužiaľ nemáme skladom");
  expect(sent[0]?.html).not.toContain("Vlastné znenie pre");
  // Predmet ostáva z NEUPRAVENÉHO vyrenderovania (ticket edituje len text).
  expect(sent[0]?.subject).toBe("Vlastný predmet — Ján Novák");

  const afterSend = (await db.select().from(mailTemplates).where(eq(mailTemplates.key, "nedostupne")))[0];
  expect(afterSend).toEqual(beforeSend);

  const logRow = (await db.select({ recipient: mailLog.recipient, body: mailLog.body }).from(mailLog))[0];
  expect(logRow?.recipient).toBe("jan@example.sk");
  expect(logRow?.body).toBe(editedText);
});

async function seedActor(db: Awaited<ReturnType<typeof boot>>): Promise<string> {
  const { users } = await import("../src/db/schema.js");
  const { hashPassword } = await import("../src/modules/auth/passwords.js");
  const [row] = await db
    .insert(users)
    .values({ email: "sablona-autor@forestshop.sk", passwordHash: await hashPassword("heslo-testovacie"), displayName: "Autor šablóny", role: "manazer" })
    .returning({ id: users.id });
  if (row === undefined) throw new Error("test používateľ sa nepodarilo vložiť");
  return row.id;
}

it("order-merge: editedBody nahradí vygenerované znenie, Kniha uloží upravený text", async () => {
  const db = await boot();
  const [base] = await db
    .insert(orders)
    .values({ externalOrderId: "27700101", customerName: "Eva Kováčová", statusName: DEFAULT_ORDER_OPEN_STATUS, placedAt: new Date("2026-08-01T09:00:00Z"), email: "eva@example.sk" })
    .returning({ id: orders.id });
  const [other] = await db
    .insert(orders)
    .values({ externalOrderId: "27700102", customerName: "Eva Kováčová", statusName: DEFAULT_ORDER_OPEN_STATUS, placedAt: new Date("2026-08-01T10:00:00Z"), email: "eva@example.sk" })
    .returning({ id: orders.id });
  if (base === undefined || other === undefined) throw new Error("test objednávky sa nepodarilo vložiť");

  const { transport, sent } = fakeMail();
  const editedText = "Ahoj Eva,\n\nobe tvoje objednávky posielame spolu v jednej zásielke.\n\nĎakujeme!";
  const result = await sendOrderMergeMail({
    db,
    now: new Date("2026-08-01T12:00:00Z"),
    baseOrderId: base.id,
    otherOrderIds: [other.id],
    mailTransport: transport,
    bccEmail: "majitel@forestshop.sk",
    editedBody: editedText,
  });
  expect(result.status).toBe("sent");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.text).toBe(editedText);
  expect(sent[0]?.html).toContain("obe tvoje objednávky posielame spolu");

  const logRow = (await db.select({ body: mailLog.body }).from(mailLog))[0];
  expect(logRow?.body).toBe(editedText);
});

// HTTP-úrovňový dôkaz — náhľad vracia `text` (frontend ho predvyplní do
// editovateľného okna), `/send` prijme `editedBody`, a `GET /api/mail-log`
// vráti uložené telo (rovnaká cesta ako obsluha uvidí na obrazovke Kniha
// odoslaných e-mailov).
const HESLO = "test-heslo-abc";

afterEach(() => {
  resetLoginRateLimit();
});

async function bootHttp(nedostupneSent: MailMessage[], orderMergeSent: MailMessage[]) {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({ email: "pouzivatel@forestshop.sk", passwordHash: await hashPassword(HESLO), displayName: "Test", role: "manazer" });
  const app = createApp(ctx.db, {
    cookieSecure: false,
    nedostupne: {
      mailTransport: (m: MailMessage) => {
        nedostupneSent.push(m);
        return Promise.resolve();
      },
      bccEmail: "majitel@forestshop.sk",
      adminBaseUrl: "https://www.forestshop.sk",
    },
    orderMerge: {
      mailTransport: (m: MailMessage) => {
        orderMergeSent.push(m);
        return Promise.resolve();
      },
      bccEmail: "majitel@forestshop.sk",
    },
  });
  const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "pouzivatel@forestshop.sk", password: HESLO }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db };
}

it("HTTP: nedostupne náhľad vráti 'text', /send prijme editedBody, mail-log ukáže uložené telo", async () => {
  const nedostupneSent: MailMessage[] = [];
  const { app, cookie, db } = await bootHttp(nedostupneSent, []);
  await insertTestVariantForProduct(db, "P277B", "P277B", { productName: "Čiapka Test" });
  const [order] = await db
    .insert(orders)
    .values({ externalOrderId: "27700201", customerName: "Marek Test", statusName: DEFAULT_ORDER_OPEN_STATUS, placedAt: new Date("2026-08-01T10:00:00Z"), email: "marek@example.sk" })
    .returning({ id: orders.id });
  if (order === undefined) throw new Error("test objednávka sa nepodarilo vložiť");
  await db.insert(orderLines).values({ orderId: order.id, variantCode: "P277B", quantity: 1, state: "nedostupne" });

  const previewRes = await app.request("/api/nedostupne/preview", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "27700201", variantCode: "P277B", emailType: "nedostupne" }),
  });
  const preview = (await previewRes.json()) as { ok: boolean; text: string; previewToken: string };
  expect(preview.ok).toBe(true);
  expect(typeof preview.text).toBe("string");
  expect(preview.text.length).toBeGreaterThan(0);

  const editedText = "Marek, tvoj tovar bohužiaľ nemáme — ozveme sa s náhradou.";
  const sendRes = await app.request("/api/nedostupne/send", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ orderCode: "27700201", variantCode: "P277B", emailType: "nedostupne", previewToken: preview.previewToken, editedBody: editedText }),
  });
  expect((await sendRes.json() as { ok: boolean }).ok).toBe(true);
  expect(nedostupneSent[0]?.text).toBe(editedText);

  const logRes = await app.request("/api/mail-log", { headers: { cookie } });
  const logBody = (await logRes.json()) as { rows: { body: string | null }[] };
  expect(logBody.rows[0]?.body).toBe(editedText);
});
