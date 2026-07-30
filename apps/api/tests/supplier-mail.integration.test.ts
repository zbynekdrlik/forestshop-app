import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { auditEvents, orderLines, orders, supplierContacts, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import type { MailMessage, MailTransport } from "../src/modules/mail/transport.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { insertTestVariant } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

const HESLO = "test-heslo-abc"; // testovacie údaje, nie tajomstvo

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

// Fake transport (externá služba — SMTP — je jediné, čo `test-strictness.md`
// dovoľuje mockovať; nič INTERNÉ tu nie je mockované, `sendSupplierOrderMail`/
// `buildSupplierOrderMailContent` bežia naozaj nad reálnou DB).
function fakeTransport(): { readonly transport: MailTransport; readonly sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  const transport: MailTransport = (message) => {
    sent.push(message);
    return Promise.resolve();
  };
  return { transport, sent };
}

function failingTransport(): MailTransport {
  return () => Promise.reject(new Error("SMTP spojenie zlyhalo: connect ECONNREFUSED"));
}

async function boot(role: UserRole, sendSupplierMail?: MailTransport) {
  const ctx = await withCleanDb();
  close = ctx.close;
  const [pouzivatel] = await ctx.db
    .insert(users)
    .values({
      email: "manazer@forestshop.sk",
      passwordHash: await hashPassword(HESLO),
      displayName: "Manažér",
      role,
    })
    .returning({ id: users.id });
  if (pouzivatel === undefined) throw new Error("testovací používateľ sa nepodarilo vložiť");

  const app = createApp(ctx.db, {
    cookieSecure: false,
    ...(sendSupplierMail === undefined ? {} : { sendSupplierMail }),
  });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "manazer@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db, userId: pouzivatel.id };
}

// --- PUT /api/suppliers/:supplier/email -------------------------------------

it("manažér nastaví e-mail dodávateľa, zápis sa objaví v /api/orders/open aj v audite", async () => {
  const { app, cookie, db, userId } = await boot("manazer");
  await insertTestVariant(db, "A-1", "Dodávateľ Alfa");
  await db
    .insert(orders)
    .values({ externalOrderId: "5001", customerName: "Zákazník", placedAt: new Date("2026-07-01T00:00:00Z") })
    .returning()
    .then(async ([o]) => {
      if (o === undefined) throw new Error("insert zlyhal");
      await db.insert(orderLines).values({ orderId: o.id, variantCode: "A-1", quantity: 1 });
    });

  const res = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ Alfa")}/email`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "alfa@dodavatel.example" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, email: "alfa@dodavatel.example" });

  const openRes = await app.request("/api/orders/open", { headers: { cookie } });
  const openTelo = (await openRes.json()) as { suppliers: { supplier: string; email: string | null }[] };
  const alfa = openTelo.suppliers.find((s) => s.supplier === "Dodávateľ Alfa");
  expect(alfa?.email).toBe("alfa@dodavatel.example");

  const udalosti = await db.select().from(auditEvents);
  const udalost = udalosti.find((e) => e.action === "supplier_contact.email.changed");
  expect(udalost).toBeDefined();
  expect(udalost?.actorUserId).toBe(userId);
  expect(udalost?.entityId).toBe("Dodávateľ Alfa");
  expect(udalost?.data).toMatchObject({ supplier: "Dodávateľ Alfa", email: "alfa@dodavatel.example" });
});

it("prázdny reťazec vymaže e-mail dodávateľa (nastaví na null)", async () => {
  const { app, cookie, db } = await boot("manazer");
  await db.insert(supplierContacts).values({ supplier: "Dodávateľ Alfa", email: "stary@dodavatel.example" });

  const res = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ Alfa")}/email`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, email: null });

  const [riadok] = await db.select().from(supplierContacts).where(eq(supplierContacts.supplier, "Dodávateľ Alfa"));
  expect(riadok?.email).toBeNull();
});

it("rola citanie nesmie nastaviť e-mail dodávateľa (403)", async () => {
  const { app, cookie } = await boot("citanie");
  const res = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ Alfa")}/email`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "x@example.com" }),
  });
  expect(res.status).toBe(403);
});

it("nastavenie e-mailu s cudzím Origin je odmietnuté (403)", async () => {
  const { app, cookie } = await boot("manazer");
  const res = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ Alfa")}/email`, {
    method: "PUT",
    headers: {
      cookie,
      "content-type": "application/json",
      origin: "https://utocnik.example",
      host: "forestshop.example",
    },
    body: JSON.stringify({ email: "x@example.com" }),
  });
  expect(res.status).toBe(403);
});

it("neplatný formát e-mailu vráti 400", async () => {
  const { app, cookie } = await boot("manazer");
  const res = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ Alfa")}/email`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "nie-je-to-mail" }),
  });
  expect(res.status).toBe(400);
});

// --- GET /api/suppliers/:supplier/order-mail (náhľad) -----------------------

it("náhľad agreguje množstvo podľa kódu variantu naprieč objednávkami, vynecháva už vybavené riadky", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "4859/46", "Dodávateľ Alfa");

  const [obj1] = await db
    .insert(orders)
    .values({ externalOrderId: "6001", customerName: "Zákazník 1", placedAt: new Date("2026-07-01T00:00:00Z") })
    .returning();
  const [obj2] = await db
    .insert(orders)
    .values({ externalOrderId: "6002", customerName: "Zákazník 2", placedAt: new Date("2026-07-02T00:00:00Z") })
    .returning();
  if (obj1 === undefined || obj2 === undefined) throw new Error("insert zlyhal");

  // Dve objednávky rovnakého variantu vo východiskovom stave "objednane" —
  // majú sa SČÍTAŤ (2 + 3 = 5). Tretia objednávka toho istého variantu je už
  // "skladom" (vybavená) — nemá sa objaviť v maile vôbec.
  await db.insert(orderLines).values({ orderId: obj1.id, variantCode: "4859/46", quantity: 2 });
  await db.insert(orderLines).values({ orderId: obj2.id, variantCode: "4859/46", quantity: 3 });

  await insertTestVariant(db, "9999/S", "Dodávateľ Alfa");
  const [obj3] = await db
    .insert(orders)
    .values({ externalOrderId: "6003", customerName: "Zákazník 3", placedAt: new Date("2026-07-03T00:00:00Z") })
    .returning();
  if (obj3 === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: obj3.id, variantCode: "9999/S", quantity: 7, state: "skladom" });

  await db.insert(supplierContacts).values({ supplier: "Dodávateľ Alfa", email: "alfa@dodavatel.example" });

  const res = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ Alfa")}/order-mail`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const telo = (await res.json()) as { to: string | null; subject: string; body: string; itemCount: number };
  expect(telo.to).toBe("alfa@dodavatel.example");
  expect(telo.itemCount).toBe(1);
  expect(telo.subject).toBe("Objednávka — Dodávateľ Alfa (1 položka)");
  expect(telo.body).toBe("Objednávka — Dodávateľ Alfa (1 položka)\n4859/46 | 5 ks");
});

it("náhľad pre dodávateľa bez e-mailu vráti to: null", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "Z-1", "Dodávateľ Zeta");
  const [obj] = await db
    .insert(orders)
    .values({ externalOrderId: "7001", customerName: "Zákazník", placedAt: new Date("2026-07-01T00:00:00Z") })
    .returning();
  if (obj === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: obj.id, variantCode: "Z-1", quantity: 1 });

  const res = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ Zeta")}/order-mail`, {
    headers: { cookie },
  });
  expect((await res.json()) as { to: string | null }).toMatchObject({ to: null });
});

// --- POST /api/suppliers/:supplier/order-mail/send --------------------------

it("manažér odošle objednávku mailom, audit nesie príjemcu a počet položiek", async () => {
  const { transport, sent } = fakeTransport();
  const { app, cookie, db, userId } = await boot("manazer", transport);
  await insertTestVariant(db, "4859/46", "Dodávateľ Alfa");
  const [obj] = await db
    .insert(orders)
    .values({ externalOrderId: "8001", customerName: "Zákazník", placedAt: new Date("2026-07-01T00:00:00Z") })
    .returning();
  if (obj === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: obj.id, variantCode: "4859/46", quantity: 4 });
  await db.insert(supplierContacts).values({ supplier: "Dodávateľ Alfa", email: "alfa@dodavatel.example" });

  const res = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ Alfa")}/order-mail/send`, {
    method: "POST",
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, to: "alfa@dodavatel.example", itemCount: 1 });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    to: "alfa@dodavatel.example",
    subject: "Objednávka — Dodávateľ Alfa (1 položka)",
    text: "Objednávka — Dodávateľ Alfa (1 položka)\n4859/46 | 4 ks",
  });

  const udalosti = await db.select().from(auditEvents);
  const udalost = udalosti.find((e) => e.action === "orders.mail.send");
  expect(udalost).toBeDefined();
  expect(udalost?.actorUserId).toBe(userId);
  expect(udalost?.data).toMatchObject({
    supplier: "Dodávateľ Alfa",
    status: "sent",
    recipient: "alfa@dodavatel.example",
    itemCount: 1,
  });

  // Odoslanie NEMENÍ stav riadku (návrhové rozhodnutie na tickete #31) —
  // zostáva vo východiskovom stave "objednane".
  const [riadok] = await db.select().from(orderLines).where(eq(orderLines.orderId, obj.id));
  expect(riadok?.state).toBe("objednane");
});

it("odoslanie bez nastaveného e-mailu vráti ok:false (200), nič sa neodošle", async () => {
  const { transport, sent } = fakeTransport();
  const { app, cookie, db } = await boot("manazer", transport);
  await insertTestVariant(db, "N-1", "Dodávateľ Bez mailu");
  const [obj] = await db
    .insert(orders)
    .values({ externalOrderId: "8002", customerName: "Zákazník", placedAt: new Date("2026-07-01T00:00:00Z") })
    .returning();
  if (obj === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: obj.id, variantCode: "N-1", quantity: 1 });

  const res = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ Bez mailu")}/order-mail/send`, {
    method: "POST",
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: false });
  expect(sent).toHaveLength(0);
});

it("odoslanie bez outstanding položiek vráti ok:false (200), nič sa neodošle", async () => {
  const { transport, sent } = fakeTransport();
  const { app, cookie, db } = await boot("manazer", transport);
  await insertTestVariant(db, "V-1", "Dodávateľ Vybavený");
  const [obj] = await db
    .insert(orders)
    .values({ externalOrderId: "8003", customerName: "Zákazník", placedAt: new Date("2026-07-01T00:00:00Z") })
    .returning();
  if (obj === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: obj.id, variantCode: "V-1", quantity: 1, state: "skladom" });
  await db.insert(supplierContacts).values({ supplier: "Dodávateľ Vybavený", email: "vybaveny@example.com" });

  const res = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ Vybavený")}/order-mail/send`, {
    method: "POST",
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: false });
  expect(sent).toHaveLength(0);
});

it("zlyhanie SMTP odoslania vráti 502 (nie 200/500), audit nesie status send_failed", async () => {
  const { app, cookie, db, userId } = await boot("manazer", failingTransport());
  await insertTestVariant(db, "F-1", "Dodávateľ Padne");
  const [obj] = await db
    .insert(orders)
    .values({ externalOrderId: "8004", customerName: "Zákazník", placedAt: new Date("2026-07-01T00:00:00Z") })
    .returning();
  if (obj === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: obj.id, variantCode: "F-1", quantity: 1 });
  await db.insert(supplierContacts).values({ supplier: "Dodávateľ Padne", email: "padne@example.com" });

  const res = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ Padne")}/order-mail/send`, {
    method: "POST",
    headers: { cookie },
  });
  expect(res.status).toBe(502);
  const telo = (await res.json()) as { error: string };
  expect(telo.error).not.toContain("ECONNREFUSED");

  const udalosti = await db.select().from(auditEvents);
  const udalost = udalosti.find((e) => e.action === "orders.mail.send");
  expect(udalost?.actorUserId).toBe(userId);
  expect(udalost?.data).toMatchObject({ supplier: "Dodávateľ Padne", status: "send_failed" });
});

it("bez nakonfigurovaného MAIL_HOST vráti odoslanie 503", async () => {
  const { app, cookie, db } = await boot("manazer");
  await insertTestVariant(db, "C-1", "Dodávateľ Chýba mailer");
  const [obj] = await db
    .insert(orders)
    .values({ externalOrderId: "8005", customerName: "Zákazník", placedAt: new Date("2026-07-01T00:00:00Z") })
    .returning();
  if (obj === undefined) throw new Error("insert zlyhal");
  await db.insert(orderLines).values({ orderId: obj.id, variantCode: "C-1", quantity: 1 });
  await db.insert(supplierContacts).values({ supplier: "Dodávateľ Chýba mailer", email: "x@example.com" });

  const res = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ Chýba mailer")}/order-mail/send`, {
    method: "POST",
    headers: { cookie },
  });
  expect(res.status).toBe(503);
});

it("rola citanie nesmie odoslať objednávku mailom (403)", async () => {
  const { transport } = fakeTransport();
  const { app, cookie } = await boot("citanie", transport);
  const res = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ Alfa")}/order-mail/send`, {
    method: "POST",
    headers: { cookie },
  });
  expect(res.status).toBe(403);
});

it("odoslanie s cudzím Origin je odmietnuté (403)", async () => {
  const { transport } = fakeTransport();
  const { app, cookie } = await boot("manazer", transport);
  const res = await app.request(`/api/suppliers/${encodeURIComponent("Dodávateľ Alfa")}/order-mail/send`, {
    method: "POST",
    headers: { cookie, origin: "https://utocnik.example", host: "forestshop.example" },
  });
  expect(res.status).toBe(403);
});
