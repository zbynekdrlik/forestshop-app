import { afterEach, expect, it } from "vitest";
import { mailLog, users } from "../src/db/schema.js";
import { createApp } from "../src/http/app.js";
import { resetLoginRateLimit } from "../src/http/login-rate-limit.js";
import { hashPassword } from "../src/modules/auth/passwords.js";
import { DUPLICATE_REASON, listMailLog, summarizeMailLog } from "../src/modules/mail-log/queries.js";
import { recordSkippedMail, sendLoggedMail, type MailLogContext } from "../src/modules/mail-log/service.js";
import { withCleanDb } from "./helpers/db.js";

// issue 193, majiteľ: "v automatizaciach dufam su vsetky potrebne statistiky
// komu sa poslal mail a tak dalej". Žiadny SKUTOČNÝ e-mail tu neodchádza —
// transport je vždy falošný (`.claude/rules/testing.md`).
const HESLO = "test-heslo-abc";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  resetLoginRateLimit();
});

async function boot() {
  const ctx = await withCleanDb();
  close = ctx.close;
  await ctx.db.insert(users).values({
    email: "pouzivatel@forestshop.sk",
    passwordHash: await hashPassword(HESLO),
    displayName: "Test Používateľ",
    role: "manazer",
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

const CTX: MailLogContext = {
  source: "posta_uncollected",
  trigger: "scheduled",
  templateKey: "posta_1",
  orderCode: "20260001",
  packageNumber: "RR123456789SK",
  sequence: 1,
};

it("úspešné odoslanie zapíše komu, kedy, čoho sa týkalo a s akým predmetom", async () => {
  const { db } = await boot();
  const odoslane: string[] = [];
  const result = await sendLoggedMail(
    db,
    async (m) => {
      odoslane.push(m.to);
      await Promise.resolve();
    },
    { to: "zakaznik@example.com", subject: "Zásielka čaká na pošte", text: "…", bcc: "majitel@example.com" },
    new Date("2026-08-03T10:00:00Z"),
    CTX,
  );

  expect(result.ok).toBe(true);
  expect(odoslane).toEqual(["zakaznik@example.com"]);
  const rows = await listMailLog(db, { limit: 10 }, "https://www.forestshop.sk");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("sent");
  expect(rows[0]?.recipient).toBe("zakaznik@example.com");
  expect(rows[0]?.orderCode).toBe("20260001");
  expect(rows[0]?.packageNumber).toBe("RR123456789SK");
  expect(rows[0]?.sequence).toBe(1);
  expect(rows[0]?.subject).toBe("Zásielka čaká na pošte");
  // Odkaz do Shoptetu sa skladá aj pre objednávku, ktorá v databáze nie je
  // (vyhľadávacia podoba) — kniha e-mailov nesmie zmiznúť s objednávkou.
  expect(rows[0]?.adminLink).toContain("20260001");
});

it("zlyhané odoslanie zapíše dôvod a NEvyhodí výnimku", async () => {
  const { db } = await boot();
  const result = await sendLoggedMail(
    db,
    () => Promise.reject(new Error("SMTP timeout")),
    { to: "zakaznik@example.com", subject: "Zásielka čaká na pošte", text: "…" },
    new Date("2026-08-03T10:00:00Z"),
    CTX,
  );

  expect(result.ok).toBe(false);
  const rows = await listMailLog(db, { limit: 10 }, "https://www.forestshop.sk");
  expect(rows[0]?.status).toBe("failed");
  expect(rows[0]?.reason).toBe("SMTP timeout");
});

it("preskočenie s tým istým dôvodom sa v rámci 24 h nezapíše druhýkrát", async () => {
  const { db } = await boot();
  const prvy = new Date("2026-08-03T10:00:00Z");
  await recordSkippedMail(db, prvy, CTX, "", "objednávka nemá e-mailovú adresu zákazníka");
  // O hodinu neskôr (ďalší beh) — rovnaký dôvod, rovnaká objednávka.
  await recordSkippedMail(db, new Date("2026-08-03T11:00:00Z"), CTX, "", "objednávka nemá e-mailovú adresu zákazníka");
  expect(await db.select().from(mailLog)).toHaveLength(1);

  // O 25 hodín neskôr už áno — majiteľ má vidieť, že problém trvá aj dnes.
  await recordSkippedMail(db, new Date("2026-08-04T11:00:00Z"), CTX, "", "objednávka nemá e-mailovú adresu zákazníka");
  expect(await db.select().from(mailLog)).toHaveLength(2);
});

it("súhrn počíta odoslané/zlyhané/preskočené a zvlášť zabránené duplicity", async () => {
  const { db } = await boot();
  const now = new Date("2026-08-03T10:00:00Z");
  await sendLoggedMail(db, () => Promise.resolve(), { to: "a@example.com", subject: "s", text: "t" }, now, CTX);
  await sendLoggedMail(db, () => Promise.reject(new Error("SMTP")), { to: "b@example.com", subject: "s", text: "t" }, now, CTX);
  await recordSkippedMail(db, now, { ...CTX, orderCode: "20260002" }, "c@example.com", DUPLICATE_REASON);
  await recordSkippedMail(db, now, { ...CTX, orderCode: "20260003" }, "", "objednávka nemá e-mailovú adresu zákazníka");

  const summary = await summarizeMailLog(db, { limit: 200 });
  expect(summary).toEqual({ sent: 1, failed: 1, skipped: 2, duplicatesBlocked: 1 });
});

it("HTTP: prehľad vracia riadky aj súhrn, filtruje podľa automatizácie a stavu", async () => {
  const { app, cookie, db } = await boot();
  const now = new Date();
  await sendLoggedMail(db, () => Promise.resolve(), { to: "a@example.com", subject: "s", text: "t" }, now, CTX);
  await sendLoggedMail(
    db,
    () => Promise.resolve(),
    { to: "d@example.com", subject: "objednávka", text: "t" },
    now,
    { source: "supplier_order", trigger: "manual", templateKey: "supplier_order" },
  );

  const vsetko = await app.request("/api/mail-log", { headers: { cookie } });
  expect(vsetko.status).toBe(200);
  const telo = (await vsetko.json()) as { rows: readonly { source: string }[]; summary: { sent: number } };
  expect(telo.rows).toHaveLength(2);
  expect(telo.summary.sent).toBe(2);

  const lenDodavatel = await app.request("/api/mail-log?source=supplier_order", { headers: { cookie } });
  const filtrovane = (await lenDodavatel.json()) as { rows: readonly { source: string }[]; summary: { sent: number } };
  expect(filtrovane.rows.map((r) => r.source)).toEqual(["supplier_order"]);
  // Súhrn ZÁMERNE ignoruje filter stavu, ale filter automatizácie rešpektuje.
  expect(filtrovane.summary.sent).toBe(1);
});

it("HTTP: neprihlásený sa k prehľadu nedostane", async () => {
  const { app } = await boot();
  const res = await app.request("/api/mail-log");
  expect(res.status).toBe(401);
});
