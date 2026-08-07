import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { orders, upozornenie } from "../src/db/schema.js";
import { runPostaUncollected } from "../src/modules/posta-uncollected/run.js";
import type { TrackingClient } from "../src/modules/posta-uncollected/tracking-client.js";
import { withCleanDb } from "./helpers/db.js";

// issue 299: šéf chce upozornenie na zásielku VRÁTENÚ ODOSIELATEĽOVI —
// TRETÍ automatický zdroj (`vratena_zasielka`, DRUHÝ tvar z toho istého
// denného behu ako `nevyzdvihnuta_zasielka`, ale iný VÝZNAM). Klasifikácia
// (`isReturnedToSender`) beží na dvoch stateCodoch POTVRDENÝCH naživo
// 2026-08-07 (`constants.ts`'s `RETURNED_STATE_CODES` komentár —
// "returning"/"returned"), preto tieto testy nechávajú falošný tracking
// klient vracať `stateCode: "returned"` (finálny potvrdený stav).
//
// VYČLENENÉ do vlastného súboru (ten istý dôvod ako
// `orders-http.integration.test.ts`/`orders-http-state.integration.test.ts`
// split, `.claude/rules/frontend-design.md`'s "max-lines 400" vzor) —
// pridanie tejto skupiny testov priamo do `posta-uncollected-run
// .integration.test.ts` by ho posunulo na 483 neprázdnych/nekomentárových
// riadkov, nad eslint `max-lines: 400`.
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

function returnedTrackingClient(): TrackingClient {
  return () => Promise.resolve({ results: [{ status: "ok", events: [{ stateCode: "returned" }] }] });
}

it("vrátená zásielka vyrobí kartu vratena_zasielka s odkazom na sledovanie na Pošte SK — v SAMOSTATNOM mennom priestore od nevyzdvihnuta_zasielka", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20500018" });

  await runPostaUncollected({
    db,
    now: TODAY,
    trackingClient: returnedTrackingClient(),
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: "https://www.forestshop.sk",
  });

  const rows = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "posta-vratena:EF123456789SK"));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.type).toBe("vratena_zasielka");
  expect(rows[0]?.source).toBe("appka");
  expect(rows[0]?.title).toContain("20500018");
  expect(rows[0]?.details).toContain("Zákazník: Ján Novák");
  expect(rows[0]?.details).toContain("EF123456789SK");
  expect(rows[0]?.link).toBe("https://www.posta.sk/sledovanie-zasielok#parcel=EF123456789SK");
  expect(rows[0]?.resolvedAt).toBeNull();

  // Vrátená zásielka už nie je "čaká na vyzdvihnutie" — nesmie sa objaviť v
  // existujúcom výsledku "Nevyzdvihnuté zásielky", ani vyrobiť druhú kartu
  // pod pôvodným `posta:` dedupKey.
  const uncollectedRows = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "posta:EF123456789SK"));
  expect(uncollectedRows).toHaveLength(0);
});

it("bežná (notified) zásielka NEVYROBÍ kartu vratena_zasielka", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20500019" });

  await runPostaUncollected({
    db,
    now: TODAY,
    trackingClient: notifiedTrackingClient(),
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: "https://www.forestshop.sk",
  });

  const rows = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "posta-vratena:EF123456789SK"));
  expect(rows).toHaveLength(0);
});

it("vrátenie AUTO-ZAVRIE existujúcu nevyzdvihnutá_zasielka kartu tej istej zásielky (resolvedByUserId zostáva null)", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20500020" });

  await runPostaUncollected({
    db,
    now: TODAY,
    trackingClient: notifiedTrackingClient(),
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: "https://www.forestshop.sk",
  });
  const midway = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "posta:EF123456789SK"));
  expect(midway).toHaveLength(1);
  expect(midway[0]?.resolvedAt).toBeNull();

  await runPostaUncollected({
    db,
    now: new Date("2026-08-03T10:00:00Z"),
    trackingClient: returnedTrackingClient(),
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: "https://www.forestshop.sk",
  });

  const after = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "posta:EF123456789SK"));
  expect(after).toHaveLength(1);
  expect(after[0]?.resolvedAt).not.toBeNull();
  expect(after[0]?.resolvedByUserId).toBeNull();

  const returnedRows = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "posta-vratena:EF123456789SK"));
  expect(returnedRows).toHaveLength(1);
  expect(returnedRows[0]?.resolvedAt).toBeNull();
});

it("keď tracking prestane hlásiť vrátenie (zmenil sa/omylom rozpoznaný kód), karta vratena_zasielka sa AUTO-ZAVRIE sama", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20500021" });

  await runPostaUncollected({
    db,
    now: TODAY,
    trackingClient: returnedTrackingClient(),
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: "https://www.forestshop.sk",
  });
  const midway = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "posta-vratena:EF123456789SK"));
  expect(midway).toHaveLength(1);
  expect(midway[0]?.resolvedAt).toBeNull();

  await runPostaUncollected({
    db,
    now: new Date("2026-08-03T10:00:00Z"),
    trackingClient: notifiedTrackingClient(),
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: "https://www.forestshop.sk",
  });

  const after = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "posta-vratena:EF123456789SK"));
  expect(after).toHaveLength(1);
  expect(after[0]?.resolvedAt).not.toBeNull();
  expect(after[0]?.resolvedByUserId).toBeNull();
});

it("opakovaný beh na tú istú vrátenú zásielku NEVYROBÍ druhú kartu, len ju obnoví", async () => {
  const db = await boot();
  await insertOrder(db, { externalOrderId: "20500022" });
  const deps = {
    trackingClient: returnedTrackingClient(),
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
    adminBaseUrl: "https://www.forestshop.sk",
  };

  await runPostaUncollected({ db, now: TODAY, ...deps });
  await runPostaUncollected({ db, now: new Date("2026-08-03T10:00:00Z"), ...deps });

  const rows = await db.select().from(upozornenie).where(eq(upozornenie.dedupKey, "posta-vratena:EF123456789SK"));
  expect(rows).toHaveLength(1);
});
