import { eq } from "drizzle-orm";
import pg from "pg";
import { afterEach, expect, it } from "vitest";
import { orderReminderState, orders } from "../src/db/schema.js";
import type { ClassifyClient } from "../src/modules/order-reminder/classify-client.js";
import type { MailMessage } from "../src/modules/mail/transport.js";
import { ORDER_REMINDER_RUN_LOCK_KEY } from "../src/modules/order-reminder/constants.js";
import { runOrderReminder, runOrderReminderOverride } from "../src/modules/order-reminder/run.js";
import { withCleanDb } from "./helpers/db.js";

// issue 173: koniec-koncov beh — falošný AI klasifikátor (NIKDY skutočné
// OpenAI) + falošný mail transport (NIKDY skutočný SMTP), presne per
// majiteľovej bezpečnostnej podmienke pre testy.
const TODAY = new Date("2026-08-02T10:00:00Z");
const OLD_ENOUGH = new Date("2026-07-28T10:00:00Z"); // presne 5 dní staré
const TOO_YOUNG = new Date("2026-07-31T10:00:00Z"); // 2 dni staré

let close: (() => Promise<void>) | undefined;
let checker: pg.Client | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  await checker?.end();
  checker = undefined;
});

async function boot() {
  const ctx = await withCleanDb();
  close = ctx.close;
  return ctx.db;
}

async function insertOrder(
  db: Awaited<ReturnType<typeof boot>>,
  overrides: Partial<typeof orders.$inferInsert> & { externalOrderId: string },
): Promise<void> {
  await db.insert(orders).values({
    customerName: "Ján Novák",
    statusName: "Vybavuje sa",
    placedAt: OLD_ENOUGH,
    email: "jan@example.sk",
    shopRemark: null,
    ...overrides,
  });
}

function fakeContactedClassifier(contacted: boolean): { client: ClassifyClient; calls: number[] } {
  const calls: number[] = [];
  const client: ClassifyClient = () => {
    calls.push(1);
    return Promise.resolve(contacted);
  };
  return { client, calls };
}

const ADMIN_BASE_URL = "https://www.forestshop.sk";

it("objednávka BEZ poznámky sa zobrazí ako 'bez poznámky' — e-mail sa NEPOSIELA nikdy", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20600001", shopRemark: null });
  const sent: MailMessage[] = [];

  const result = await runOrderReminder({
    db,
    now: TODAY,
    classifyClient: () => Promise.resolve(false),
    mailTransport: (m) => {
      sent.push(m);
      return Promise.resolve();
    },
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: ADMIN_BASE_URL,
  });

  expect(result.noNote).toHaveLength(1);
  expect(result.noNote[0]?.orderCode).toBe("20600001");
  expect(sent).toHaveLength(0);
  expect(result.contacted).toHaveLength(0);
  expect(result.emailed).toHaveLength(0);
});

it("objednávka s poznámkou ale BEZ e-mailu sa zobrazí v 'bez e-mailu' — AI sa vôbec nepýta", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20600002", shopRemark: "volať zákazníka", email: null });
  const { client, calls } = fakeContactedClassifier(false);

  const result = await runOrderReminder({
    db,
    now: TODAY,
    classifyClient: client,
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: ADMIN_BASE_URL,
  });

  expect(result.noEmail).toHaveLength(1);
  expect(calls).toHaveLength(0);
});

it("mladšia ako 4 dni objednávka sa vôbec nezobrazí (ani ako čakajúca)", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20600003", shopRemark: "niečo", placedAt: TOO_YOUNG });

  const result = await runOrderReminder({
    db,
    now: TODAY,
    classifyClient: () => Promise.resolve(false),
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: ADMIN_BASE_URL,
  });

  expect(result.stats.candidates).toBe(0);
});

it("chýbajúci OPENAI_API_KEY (classifyClient undefined) → 'čaká', nikdy nehádaj", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20600004", shopRemark: "volať zákazníka" });

  const result = await runOrderReminder({
    db,
    now: TODAY,
    classifyClient: undefined,
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: ADMIN_BASE_URL,
  });

  expect(result.aiNotConfigured).toBe(true);
  expect(result.pending).toHaveLength(1);
  expect(result.pending[0]?.reason).toContain("OPENAI_API_KEY");
});

it("chýbajúca BCC adresa → 'čaká', AI sa NEPÝTA (platená operácia sa neminie zbytočne)", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20600005", shopRemark: "volať zákazníka" });
  const { client, calls } = fakeContactedClassifier(false);

  const result = await runOrderReminder({
    db,
    now: TODAY,
    classifyClient: client,
    mailTransport: undefined,
    bccEmail: undefined,
    adminBaseUrl: ADMIN_BASE_URL,
  });

  expect(result.bccMissing).toBe(true);
  expect(result.pending).toHaveLength(1);
  expect(calls).toHaveLength(0);
});

it("AI usúdi 'už kontaktovaný' → žiadny e-mail, trvalý zápis 'contacted'/'ai'", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20600006", shopRemark: "volané so zákazníkom, počká" });
  const sent: MailMessage[] = [];

  const result = await runOrderReminder({
    db,
    now: TODAY,
    classifyClient: () => Promise.resolve(true),
    mailTransport: (m) => {
      sent.push(m);
      return Promise.resolve();
    },
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: ADMIN_BASE_URL,
  });

  expect(sent).toHaveLength(0);
  expect(result.contacted).toHaveLength(1);
  expect(result.contacted[0]?.resolvedBy).toBe("ai");

  const [state] = await db.select().from(orderReminderState).where(eq(orderReminderState.orderCode, "20600006"));
  expect(state?.resolution).toBe("contacted");
  expect(state?.resolvedBy).toBe("ai");
});

it("AI usúdi 'nekontaktovaný' → pošle presne JEDEN e-mail s BCC majiteľovi, zapíše 'emailed'", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20600007", shopRemark: "volať zákazníka" });
  const sent: MailMessage[] = [];

  const deps = {
    classifyClient: () => Promise.resolve(false),
    mailTransport: (m: MailMessage) => {
      sent.push(m);
      return Promise.resolve();
    },
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: ADMIN_BASE_URL,
  };

  const result = await runOrderReminder({ db, now: TODAY, ...deps });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe("jan@example.sk");
  expect(sent[0]?.bcc).toBe("majitel@forestshop.sk");
  expect(result.emailed).toHaveLength(1);
  expect(result.emailed[0]?.resolvedBy).toBe("ai");

  // Druhý beh v ten istý deň, NEZMENENÁ objednávka → rýchla cesta, ŽIADEN
  // druhý e-mail (ticket: presne jeden e-mail, navždy).
  const second = await runOrderReminder({ db, now: new Date("2026-08-05T10:00:00Z"), ...deps });
  expect(sent).toHaveLength(1); // stále len jeden
  expect(second.emailed).toHaveLength(1);
});

it("ZMENA poznámky po odoslaní e-mailu sa AJ TAK nespracuje druhýkrát (max 1 e-mail navždy)", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20600008", shopRemark: "volať zákazníka" });
  const sent: MailMessage[] = [];
  const deps = {
    classifyClient: () => Promise.resolve(false),
    mailTransport: (m: MailMessage) => {
      sent.push(m);
      return Promise.resolve();
    },
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: ADMIN_BASE_URL,
  };
  await runOrderReminder({ db, now: TODAY, ...deps });
  expect(sent).toHaveLength(1);

  // Zápis do DB sa nemení, len fingerprint by sa zmenil keby sa poznámka
  // upravila — tu simulujeme zmenenú poznámku BEZ zmeny "emailed" stavu.
  await db.update(orders).set({ shopRemark: "úplne iná poznámka" }).where(eq(orders.externalOrderId, "20600008"));
  await runOrderReminder({ db, now: new Date("2026-08-06T10:00:00Z"), ...deps });
  // "emailed" je TRVALÉ rozhodnutie — zmena poznámky po odoslaní nič
  // nespustí znova (na rozdiel od "contacted", ktoré sa PRED odoslaním
  // môže prehodnotiť).
  expect(sent).toHaveLength(1);
});

it("ručná akcia 'kontaktované' na 'bez poznámky' riadku — trvalé, žiadny e-mail", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20600009", shopRemark: null });

  const result = await runOrderReminderOverride({
    db,
    now: TODAY,
    orderCode: "20600009",
    action: "contact",
    classifyClient: undefined,
    mailTransport: undefined,
    bccEmail: undefined,
    adminBaseUrl: ADMIN_BASE_URL,
  });

  expect(result).toEqual({ ok: true, resolution: "contacted" });
  const [state] = await db.select().from(orderReminderState).where(eq(orderReminderState.orderCode, "20600009"));
  expect(state?.resolvedBy).toBe("manual"); // NIKDY pripísané AI (ticketova poučka)
});

it("ručná akcia 'poslať pripomienku' na 'bez poznámky' riadku (override) — pošle a zapíše 'manual'", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20600010", shopRemark: null });
  const sent: MailMessage[] = [];

  const result = await runOrderReminderOverride({
    db,
    now: TODAY,
    orderCode: "20600010",
    action: "send",
    classifyClient: undefined,
    mailTransport: (m) => {
      sent.push(m);
      return Promise.resolve();
    },
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: ADMIN_BASE_URL,
  });

  expect(result).toEqual({ ok: true, resolution: "emailed" });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.bcc).toBe("majitel@forestshop.sk");
});

it("ručné 'poslať' na UŽ odoslanú objednávku je odmietnuté — žiadny druhý mail", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20600011", shopRemark: "volať zákazníka" });
  const sent: MailMessage[] = [];
  const deps = {
    classifyClient: () => Promise.resolve(false),
    mailTransport: (m: MailMessage) => {
      sent.push(m);
      return Promise.resolve();
    },
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: ADMIN_BASE_URL,
  };
  await runOrderReminder({ db, now: TODAY, ...deps });
  expect(sent).toHaveLength(1);

  const result = await runOrderReminderOverride({ db, now: TODAY, orderCode: "20600011", action: "send", ...deps });
  expect(result).toEqual({ ok: false, code: "already_resolved", resolution: "emailed" });
  expect(sent).toHaveLength(1); // stále len jeden
});

it("objednávka, ktorá opustí otvorené stavy (napr. 'Vybavená'), stráca svoj záznam pri ďalšom behu", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20600012", shopRemark: "volať zákazníka" });
  const deps = {
    classifyClient: () => Promise.resolve(true),
    mailTransport: () => Promise.resolve(),
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: ADMIN_BASE_URL,
  };
  await runOrderReminder({ db, now: TODAY, ...deps });
  let [state] = await db.select().from(orderReminderState).where(eq(orderReminderState.orderCode, "20600012"));
  expect(state).toBeDefined();

  await db.update(orders).set({ statusName: "Vybavená" }).where(eq(orders.externalOrderId, "20600012"));
  await runOrderReminder({ db, now: new Date("2026-08-06T10:00:00Z"), ...deps });
  [state] = await db.select().from(orderReminderState).where(eq(orderReminderState.orderCode, "20600012"));
  expect(state).toBeUndefined();
});

// Rovnaká deterministická technika ako `posta-uncollected-run.integration.test.ts`
// (`pg_try_advisory_lock` z DRUHÉHO pripojenia, nikdy časovanie).
it("dva súbežné behy sa serializujú (advisory zámok), nikdy neprebehnú naraz", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20600013", shopRemark: "volať zákazníka" });

  let releaseClassify: (() => void) | undefined;
  const blockedUntilReleased = new Promise<void>((resolve) => {
    releaseClassify = resolve;
  });
  const classifyClient: ClassifyClient = async () => {
    await blockedUntilReleased;
    return false;
  };

  const runPromise = runOrderReminder({
    db,
    now: TODAY,
    classifyClient,
    mailTransport: () => Promise.resolve(),
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: ADMIN_BASE_URL,
  });

  await new Promise((resolve) => setTimeout(resolve, 100));

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") throw new Error("DATABASE_URL chýba");
  checker = new pg.Client({ connectionString: databaseUrl });
  await checker.connect();
  const midRun = await checker.query<{ pg_try_advisory_lock: boolean }>("select pg_try_advisory_lock($1)", [ORDER_REMINDER_RUN_LOCK_KEY]);
  expect(midRun.rows[0]?.pg_try_advisory_lock).toBe(false);

  releaseClassify?.();
  await runPromise;

  const afterRun = await checker.query<{ pg_try_advisory_lock: boolean }>("select pg_try_advisory_lock($1)", [ORDER_REMINDER_RUN_LOCK_KEY]);
  expect(afterRun.rows[0]?.pg_try_advisory_lock).toBe(true);
  await checker.query("select pg_advisory_unlock($1)", [ORDER_REMINDER_RUN_LOCK_KEY]);
});
