import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { orders, postaUncollectedState } from "../src/db/schema.js";
import type { MailMessage } from "../src/modules/mail/transport.js";
import { runPostaUncollected } from "../src/modules/posta-uncollected/run.js";
import type { TrackingClient } from "../src/modules/posta-uncollected/tracking-client.js";
import { withCleanDb } from "./helpers/db.js";

// issue 172: koniec-koncov beh — falošný tracking klient (NIKDY skutočné
// api.posta.sk) + falošný mail transport (NIKDY skutočný SMTP), presne per
// ticket's bezpečnostná podmienka pre testy.
const TODAY = new Date("2026-08-02T10:00:00Z");

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
