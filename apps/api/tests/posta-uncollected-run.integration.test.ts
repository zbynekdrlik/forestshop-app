import { eq } from "drizzle-orm";
import pg from "pg";
import { afterEach, expect, it } from "vitest";
import { orders, postaUncollectedState, upozornenie } from "../src/db/schema.js";
import type { MailMessage } from "../src/modules/mail/transport.js";
import { POSTA_UNCOLLECTED_RUN_LOCK_KEY, runPostaUncollected } from "../src/modules/posta-uncollected/run.js";
import type { TrackingClient } from "../src/modules/posta-uncollected/tracking-client.js";
import { withCleanDb } from "./helpers/db.js";

// issue 172: koniec-koncov beh — falošný tracking klient (NIKDY skutočné
// api.posta.sk) + falošný mail transport (NIKDY skutočný SMTP), presne per
// ticket's bezpečnostná podmienka pre testy.
const TODAY = new Date("2026-08-02T10:00:00Z");

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
    statusName: "Vybavená",
    placedAt: new Date("2026-07-20T00:00:00Z"),
    email: "jan@example.sk",
    packageNumber: "EF123456789SK",
    shippingCarrierName: "Kuriér",
    ...overrides,
  });
}

function notifiedTrackingClient(): TrackingClient {
  return () =>
    Promise.resolve({
      results: [
        {
          status: "ok",
          events: [{ stateCode: "notified", detailCode: "ZNP1AN", localDate: "2026-07-30", postOffice: { name: "Pošta 1" } }],
        },
      ],
    });
}

it("BEZ BCC adresy neposiela žiaden e-mail, aj keď je zásielka nevyzdvihnutá", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20500001" });
  const sent: MailMessage[] = [];

  const result = await runPostaUncollected({
    db,
    now: TODAY,
    trackingClient: notifiedTrackingClient(),
    mailTransport: (m) => {
      sent.push(m);
      return Promise.resolve();
    },
    bccEmail: undefined,
    adminBaseUrl: "https://www.forestshop.sk",
  });

  expect(sent).toHaveLength(0);
  expect(result.bccMissing).toBe(true);
  expect(result.stats.emailsBlocked).toBe(1);
  expect(result.uncollected).toHaveLength(1);
  expect(result.uncollected[0]?.count).toBe(0); // nebolo odoslané → počítadlo neposunuté
});

it("S BCC adresou pošle prvý e-mail a BCC vždy majiteľovi", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20500002" });
  const sent: MailMessage[] = [];

  const result = await runPostaUncollected({
    db,
    now: TODAY,
    trackingClient: notifiedTrackingClient(),
    mailTransport: (m) => {
      sent.push(m);
      return Promise.resolve();
    },
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: "https://www.forestshop.sk",
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe("jan@example.sk");
  expect(sent[0]?.bcc).toBe("majitel@forestshop.sk");
  expect(sent[0]?.subject).toContain("čaká na vyzdvihnutie");
  expect(result.stats.emailsSent).toBe(1);
  expect(result.uncollected[0]?.count).toBe(1);

  const [state] = await db.select().from(postaUncollectedState).where(eq(postaUncollectedState.orderCode, "20500002"));
  expect(state?.notifyCount).toBe(1);
});

it("druhý beh v ten istý deň NEPOŠLE druhý e-mail (kadencia 0 → +3)", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20500003" });
  const deps = {
    trackingClient: notifiedTrackingClient(),
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: "https://www.forestshop.sk",
  };
  const sent: MailMessage[] = [];
  const mailTransport = (m: MailMessage): Promise<void> => {
    sent.push(m);
    return Promise.resolve();
  };

  await runPostaUncollected({ db, now: TODAY, mailTransport, ...deps });
  expect(sent).toHaveLength(1);

  await runPostaUncollected({ db, now: TODAY, mailTransport, ...deps });
  expect(sent).toHaveLength(1); // stále len jeden — cadence
});

it("nevalidné číslo zásielky sa hlási v 'invalid', nikdy v 'uncollected'", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20500004", packageNumber: "12345678901234" });

  const result = await runPostaUncollected({
    db,
    now: TODAY,
    trackingClient: () => Promise.resolve({ results: [{ status: "invalid_format" }] }),
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: "https://www.forestshop.sk",
  });

  expect(result.invalid).toHaveLength(1);
  expect(result.invalid[0]?.orderCode).toBe("20500004");
  expect(result.uncollected).toHaveLength(0);
});

it("zlyhanie sledovania (tracking klient vráti null) sa hlási v 'errors', nikdy nespadne", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20500005" });

  const result = await runPostaUncollected({
    db,
    now: TODAY,
    trackingClient: () => Promise.resolve(null),
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: "https://www.forestshop.sk",
  });

  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]?.orderCode).toBe("20500005");
});

it("doručená zásielka (terminálny stav) sa cachuje a NEPÝTA znova na druhý beh v tom istom týždni", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20500006" });
  let calls = 0;
  const trackingClient: TrackingClient = () => {
    calls += 1;
    return Promise.resolve({ results: [{ status: "ok", events: [{ stateCode: "delivered" }] }] });
  };
  const deps = { trackingClient, mailTransport: undefined, bccEmail: "majitel@forestshop.sk", adminBaseUrl: "https://www.forestshop.sk" };

  const first = await runPostaUncollected({ db, now: TODAY, ...deps });
  expect(first.uncollected).toHaveLength(0);
  expect(calls).toBe(1);

  const second = await runPostaUncollected({ db, now: new Date("2026-08-03T10:00:00Z"), ...deps });
  expect(second.stats.apiSkipped).toBe(1);
  expect(calls).toBe(1); // druhý beh sa vôbec nepýtal API — cache
});

it("objednávka bez čísla zásielky sa vôbec nesleduje (nepočíta sa do 'checked')", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20500007", packageNumber: null });

  const result = await runPostaUncollected({
    db,
    now: TODAY,
    trackingClient: () => Promise.resolve(null),
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: "https://www.forestshop.sk",
  });

  expect(result.stats.checked).toBe(0);
  expect(result.errors).toHaveLength(0);
});

it("objednávka doručená iným dopravcom (DPD) sa nikdy nesleduje", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20500008", shippingCarrierName: "DPD doručenie na adresu" });

  const result = await runPostaUncollected({
    db,
    now: TODAY,
    trackingClient: () => Promise.resolve(null),
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: "https://www.forestshop.sk",
  });

  expect(result.stats.checked).toBe(0);
});

// Review na PR 177 (finding "no advisory lock") — DETERMINISTICKY (nie
// časovaním): kým je beh vnútri `runPostaUncollected` "zaseknutý" na
// falošnom tracking klientovi, pokus o ten istý zámok z DRUHÉHO,
// nezávislého pripojenia MUSÍ zlyhať (`pg_try_advisory_lock` je
// neblokujúci) — presne rovnaká technika ako `db-isolation-lock
// .integration.test.ts`.
it("dva súbežné behy sa serializujú (advisory zámok), nikdy neprebehnú naraz", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20500009" });

  let releaseTrackingCall: (() => void) | undefined;
  const blockedUntilReleased = new Promise<void>((resolve) => {
    releaseTrackingCall = resolve;
  });
  const trackingClient: TrackingClient = async () => {
    await blockedUntilReleased;
    return { results: [{ status: "ok", events: [{ stateCode: "notified", detailCode: "ZNP1AN", localDate: "2026-07-30" }] }] };
  };

  const runPromise = runPostaUncollected({
    db,
    now: TODAY,
    trackingClient,
    mailTransport: undefined,
    bccEmail: undefined,
    adminBaseUrl: "https://www.forestshop.sk",
  });

  // Počká, kým beh naozaj VEZME zámok (nie len že sme volanie odpálili).
  await new Promise((resolve) => setTimeout(resolve, 100));

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") throw new Error("DATABASE_URL chýba");
  checker = new pg.Client({ connectionString: databaseUrl });
  await checker.connect();
  const midRun = await checker.query<{ pg_try_advisory_lock: boolean }>("select pg_try_advisory_lock($1)", [POSTA_UNCOLLECTED_RUN_LOCK_KEY]);
  expect(midRun.rows[0]?.pg_try_advisory_lock).toBe(false);

  releaseTrackingCall?.();
  await runPromise;

  const afterRun = await checker.query<{ pg_try_advisory_lock: boolean }>("select pg_try_advisory_lock($1)", [POSTA_UNCOLLECTED_RUN_LOCK_KEY]);
  expect(afterRun.rows[0]?.pg_try_advisory_lock).toBe(true);
  await checker.query("select pg_advisory_unlock($1)", [POSTA_UNCOLLECTED_RUN_LOCK_KEY]);
});

// issue 268: nevyzdvihnutá zásielka vyrobí kartu na nástenke Upozornenia
// (#267's zdieľaná zapisovacia cesta), opakovaný beh ju len OBNOVÍ (nikdy
// druhú), a keď sa zásielka doručí/vráti, karta sa ZAVRIE SAMA (bez zásahu
// majiteľa) — presne "hotovo, keď" ticketu.
it("nevyzdvihnutá zásielka vyrobí kartu na Upozorneniach s odkazom na objednávku", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20500010" });

  await runPostaUncollected({
    db,
    now: TODAY,
    trackingClient: notifiedTrackingClient(),
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: "https://www.forestshop.sk",
  });

  const rows = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "posta:EF123456789SK"));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.type).toBe("nevyzdvihnuta_zasielka");
  expect(rows[0]?.source).toBe("appka");
  expect(rows[0]?.title).toContain("20500010");
  expect(rows[0]?.link).toContain("20500010");
  expect(rows[0]?.resolvedAt).toBeNull();
});

it("opakovaný beh na tú istú zásielku NEVYROBÍ druhú kartu, len ju obnoví", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20500011" });
  const deps = {
    trackingClient: notifiedTrackingClient(),
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: "https://www.forestshop.sk",
  };

  await runPostaUncollected({ db, now: TODAY, ...deps });
  await runPostaUncollected({ db, now: new Date("2026-08-03T10:00:00Z"), ...deps });

  const rows = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "posta:EF123456789SK"));
  expect(rows).toHaveLength(1);
});

it("doručená zásielka zavrie svoju kartu SAMA, bez zásahu majiteľa (resolvedByUserId zostáva null)", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20500012" });

  await runPostaUncollected({
    db,
    now: TODAY,
    trackingClient: notifiedTrackingClient(),
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: "https://www.forestshop.sk",
  });
  const midway = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "posta:EF123456789SK"));
  expect(midway[0]?.resolvedAt).toBeNull();

  await runPostaUncollected({
    db,
    now: new Date("2026-08-03T10:00:00Z"),
    trackingClient: () => Promise.resolve({ results: [{ status: "ok", events: [{ stateCode: "delivered" }] }] }),
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: "https://www.forestshop.sk",
  });

  const after = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "posta:EF123456789SK"));
  expect(after).toHaveLength(1);
  expect(after[0]?.resolvedAt).not.toBeNull();
  expect(after[0]?.resolvedByUserId).toBeNull();
});
