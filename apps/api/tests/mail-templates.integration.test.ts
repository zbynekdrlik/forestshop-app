import { afterEach, expect, it } from "vitest";
import { mailTemplates, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import type { UserRole } from "../src/modules/auth/service.js";
import { MAIL_TEMPLATE_KINDS } from "../src/modules/mail-templates/registry.js";
import { resolveTemplate } from "../src/modules/mail-templates/store.js";
import { withCleanDb } from "./helpers/db.js";

// issue 192: obrazovka "Texty e-mailov" cez HTTP. Nikde tu neodchádza žiadny
// e-mail — tieto trasy len čítajú a zapisujú znenie.
const HESLO = "test-heslo-abc";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot(role: UserRole) {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({
    email: "pouzivatel@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Test Používateľ",
    role,
  });
  const app = createApp(ctx.db, { cookieSecure: false });
  const login = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "pouzivatel@forestshop.sk", password: HESLO }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { app, cookie, db: ctx.db };
}

function jsonRequest(cookie: string, method: string, body?: unknown): RequestInit {
  return {
    method,
    // Bez `origin`/`sec-fetch-site` — `requireSameOrigin` nemá čo porovnať a
    // požiadavku pustí (rovnako ako ostatné integračné testy).
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

it("zoznam vráti všetky druhy e-mailov s pôvodným znením, kým sa nič neupravilo", async () => {
  const { app, cookie } = await boot("manazer");
  const res = await app.request("/api/mail-templates", { headers: { cookie } });
  expect(res.status).toBe(200);
  const payload = (await res.json()) as { templates: { key: string; subject: string; isCustomized: boolean; placeholders: unknown[] }[] };
  // issue 257: "order_merge" — deviaty druh e-mailu (Zlúčenie objednávky).
  // issue 500: "order_customer_contact" — desiaty druh (@ e-mail zákazníkovi).
  expect(payload.templates).toHaveLength(10);
  const nedostupne = payload.templates.find((t) => t.key === "nedostupne");
  expect(nedostupne?.isCustomized).toBe(false);
  expect(nedostupne?.subject).toBe(MAIL_TEMPLATE_KINDS["nedostupne"].defaultText.subject);
  expect((nedostupne?.placeholders.length ?? 0) > 0).toBe(true);
});

it("uloženie zmení znenie, ktoré odosielanie použije; vrátenie pôvodného ho vráti späť", async () => {
  const { app, cookie, db } = await boot("manazer");

  const save = await app.request("/api/mail-templates/nedostupne", jsonRequest(cookie, "PUT", { subject: "Nový predmet", body: "Ahoj {{meno_zakaznika}}" }));
  expect(await save.json()).toEqual({ ok: true });
  expect(await resolveTemplate(db, "nedostupne")).toEqual({ subject: "Nový predmet", body: "Ahoj {{meno_zakaznika}}" });

  const reset = await app.request("/api/mail-templates/nedostupne/reset", jsonRequest(cookie, "POST"));
  expect(await reset.json()).toEqual({ ok: true });
  expect(await resolveTemplate(db, "nedostupne")).toEqual(MAIL_TEMPLATE_KINDS["nedostupne"].defaultText);
  expect(await db.select().from(mailTemplates)).toHaveLength(0);
});

it("šablóna s neznámym poľom sa NEULOŽÍ — chyba pomenuje pole", async () => {
  const { app, cookie, db } = await boot("manazer");
  const res = await app.request("/api/mail-templates/nedostupne", jsonRequest(cookie, "PUT", { subject: "Vec", body: "Ahoj {{cislo_zasielky}}" }));
  // 200 s ok:false — nikdy 4xx (Chromium by inak zalogoval konzolovú chybu).
  expect(res.status).toBe(200);
  const payload = (await res.json()) as { ok: boolean; error: string };
  expect(payload.ok).toBe(false);
  expect(payload.error).toContain("{{cislo_zasielky}}");
  expect(await db.select().from(mailTemplates)).toHaveLength(0);
});

it("história zaznamená uloženie aj vrátenie pôvodného znenia, aj s menom používateľa", async () => {
  const { app, cookie } = await boot("admin");
  await app.request("/api/mail-templates/order_reminder", jsonRequest(cookie, "PUT", { subject: "A", body: "B" }));
  await app.request("/api/mail-templates/order_reminder/reset", jsonRequest(cookie, "POST"));

  const res = await app.request("/api/mail-templates/order_reminder/history", { headers: { cookie } });
  const payload = (await res.json()) as { ok: boolean; entries: { action: string; changedByName: string | null }[] };
  expect(payload.ok).toBe(true);
  expect(payload.entries.map((e) => e.action)).toEqual(["reset", "save"]);
  expect(payload.entries[0]?.changedByName).toBe("Test Používateľ");
});

it("rola „citanie“ znenie upraviť nesmie", async () => {
  const { app, cookie, db } = await boot("citanie");
  const res = await app.request("/api/mail-templates/nedostupne", jsonRequest(cookie, "PUT", { subject: "Vec", body: "Text" }));
  expect(res.status).toBe(403);
  expect(await db.select().from(mailTemplates)).toHaveLength(0);
});

it("náhľad vyrenderuje rozpísané (neuložené) znenie a nič neuloží", async () => {
  const { app, cookie, db } = await boot("manazer");
  const res = await app.request("/api/mail-templates/preview", jsonRequest(cookie, "POST", { key: "nedostupne", subject: "Vec", body: "Ahoj **{{meno_zakaznika}}**" }));
  const payload = (await res.json()) as { ok: boolean; subject: string; html: string };
  expect(payload.ok).toBe(true);
  expect(payload.subject).toBe("Vec");
  expect(payload.html).toContain("<strong>");
  expect(await db.select().from(mailTemplates)).toHaveLength(0);
});

// issue 379 review finding: náhľad musí zrkadliť PRESNE to, čo appka
// skutočne pošle — `supplier_order` je jediný druh, ktorý si kontaktnú
// pätičku vypína (`orders/mail.ts`'s `{ footer: false }`), inak by náhľad
// ukazoval pätičku, ktorú reálne odoslaný e-mail nikdy nemá.
it("náhľad supplier_order NEMÁ kontaktnú pätičku — rovnako ako skutočne odoslaný e-mail", async () => {
  const { app, cookie } = await boot("manazer");
  const res = await app.request(
    "/api/mail-templates/preview",
    jsonRequest(cookie, "POST", { key: "supplier_order", subject: "Objednávka — {{dodavatel}}", body: "Objednávka — {{dodavatel}}\n{{zoznam_poloziek}}" }),
  );
  const payload = (await res.json()) as { ok: boolean; text: string };
  expect(payload.ok).toBe(true);
  expect(payload.text).not.toContain("Tel.:");
  expect(payload.text).not.toContain("eshop@forestshop.sk");
});

it("náhľad ostatných druhov (napr. nedostupne) kontaktnú pätičku MÁ", async () => {
  const { app, cookie } = await boot("manazer");
  const res = await app.request("/api/mail-templates/preview", jsonRequest(cookie, "POST", { key: "nedostupne", subject: "Vec", body: "Ahoj." }));
  const payload = (await res.json()) as { ok: boolean; text: string };
  expect(payload.ok).toBe(true);
  expect(payload.text).toContain("Tel.:");
  expect(payload.text).toContain("eshop@forestshop.sk");
});

it("náhľad neplatnej šablóny vráti chybu namiesto rozbitého e-mailu", async () => {
  const { app, cookie } = await boot("manazer");
  const res = await app.request("/api/mail-templates/preview", jsonRequest(cookie, "POST", { key: "nedostupne", subject: "Vec", body: "{{vymyslene_pole}}" }));
  const payload = (await res.json()) as { ok: boolean; error: string };
  expect(payload.ok).toBe(false);
  expect(payload.error).toContain("{{vymyslene_pole}}");
});

it("neznámy druh e-mailu vráti 200 s vysvetlením, nikdy 404", async () => {
  const { app, cookie } = await boot("manazer");
  const res = await app.request("/api/mail-templates/vymyslene/reset", jsonRequest(cookie, "POST"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: false, error: "Neznámy druh e-mailu." });
});
