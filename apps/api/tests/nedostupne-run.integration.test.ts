import { eq } from "drizzle-orm";
import pg from "pg";
import { afterEach, expect, it } from "vitest";
import { nedostupneState, orderLines, orders, productSupplierLinkOverrides, shopProductUrl } from "../src/db/schema.js";
import type { MailMessage } from "../src/modules/mail/transport.js";
import { NEDOSTUPNE_SEND_LOCK_KEY } from "../src/modules/nedostupne/constants.js";
import { addReplacementLink } from "../src/modules/nedostupne/replacement-links.js";
import { listNedostupneGroups } from "../src/modules/nedostupne/queries.js";
import { findNedostupneContext, sendNedostupneEmail } from "../src/modules/nedostupne/send.js";
import { DEFAULT_ORDER_OPEN_STATUS } from "../src/modules/orders/open-statuses.js";
import { insertTestVariantForProduct } from "./helpers/orders.js";
import { withCleanDb } from "./helpers/db.js";

// issue 176: koniec-koncov beh — falošný mail transport (NIKDY skutočný
// SMTP), presne per majiteľovej bezpečnostnej podmienke pre testy.
const ADMIN_BASE_URL = "https://www.forestshop.sk";

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
  externalOrderId: string,
  overrides: Partial<typeof orders.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(orders)
    .values({
      externalOrderId,
      customerName: "Ján Novák",
      statusName: DEFAULT_ORDER_OPEN_STATUS,
      placedAt: new Date("2026-07-20T10:00:00Z"),
      email: "jan@example.sk",
      ...overrides,
    })
    .returning({ id: orders.id });
  if (row === undefined) throw new Error("test objednávka sa nepodarilo vložiť");
  return row.id;
}

function fakeMail(): { transport: (m: MailMessage) => Promise<void>; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    transport: (m) => {
      sent.push(m);
      return Promise.resolve();
    },
    sent,
  };
}

it("zoskupí NEDOSTUPNÝ riadok podľa variantu, spárovaný s otvorenou objednávkou", async () => {
  const db = await boot();
  await insertTestVariantForProduct(db, "P176A", "P176A/L", { productName: "Nohavice Test" });
  const orderId = await insertOrder(db, "17600001");
  await db.insert(orderLines).values({ orderId, variantCode: "P176A/L", quantity: 2, state: "nedostupne" });

  const groups = await listNedostupneGroups(db, ADMIN_BASE_URL);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.variantCode).toBe("P176A/L");
  expect(groups[0]?.itemName).toBe("Nohavice Test");
  expect(groups[0]?.orders).toHaveLength(1);
  expect(groups[0]?.orders[0]).toMatchObject({ orderCode: "17600001", customerName: "Ján Novák", email: "jan@example.sk", quantity: 2, nedostupneSent: false, alternativaSent: false });
});

it("riadok v INOM stave (nie 'nedostupne') sa nezobrazí vôbec", async () => {
  const db = await boot();
  await insertTestVariantForProduct(db, "P176B", "P176B", {});
  const orderId = await insertOrder(db, "17600002");
  await db.insert(orderLines).values({ orderId, variantCode: "P176B", quantity: 1, state: "objednane" });

  expect(await listNedostupneGroups(db, ADMIN_BASE_URL)).toEqual([]);
});

it("nedostupný riadok v UZAVRETEJ objednávke sa nezobrazí (nikdy neotravuj zákazníka, ktorý už dostal tovar)", async () => {
  const db = await boot();
  await insertTestVariantForProduct(db, "P176C", "P176C", {});
  const orderId = await insertOrder(db, "17600003", { statusName: "Vybavená" });
  await db.insert(orderLines).values({ orderId, variantCode: "P176C", quantity: 1, state: "nedostupne" });

  expect(await listNedostupneGroups(db, ADMIN_BASE_URL)).toEqual([]);
});

// issue 238: automatický `relatedCodes` návrh je preč — `listNedostupneGroups`
// vracia majiteľove RUČNE vložené odkazy (`nedostupne_replacement_link`),
// zoradené podľa vloženia, žiadny automatický "meno cez pairCode" lookup viac.
it("RUČNÉ odkazy náhrad (nedostupne_replacement_link) sa vrátia v poradí vloženia, zoskupené podľa variantu", async () => {
  const db = await boot();
  await insertTestVariantForProduct(db, "P176D", "P176D/M", { productName: "Nohavice s náhradou" });
  const orderId = await insertOrder(db, "17600004");
  await db.insert(orderLines).values({ orderId, variantCode: "P176D/M", quantity: 1, state: "nedostupne" });
  await addReplacementLink(db, "P176D/M", "https://www.forestshop.sk/prvy/", new Date("2026-08-04T10:00:00Z"));
  await addReplacementLink(db, "P176D/M", "https://www.forestshop.sk/druhy/", new Date("2026-08-04T10:01:00Z"));

  const groups = await listNedostupneGroups(db, ADMIN_BASE_URL);
  const group = groups.find((g) => g.variantCode === "P176D/M");
  expect(group?.replacementLinks.map((l) => l.url)).toEqual(["https://www.forestshop.sk/prvy/", "https://www.forestshop.sk/druhy/"]);
});

it("variant bez ručných odkazov má prázdny zoznam náhrad (žiadny automatický fallback)", async () => {
  const db = await boot();
  await insertTestVariantForProduct(db, "P176D3", "P176D3", { productName: "Bez náhrad" });
  const orderId = await insertOrder(db, "17600013");
  await db.insert(orderLines).values({ orderId, variantCode: "P176D3", quantity: 1, state: "nedostupne" });

  const groups = await listNedostupneGroups(db, ADMIN_BASE_URL);
  const group = groups.find((g) => g.variantCode === "P176D3");
  expect(group?.replacementLinks).toEqual([]);
});

// issue 238: preklik na náš e-shop (`shop_product_url`, feed pre porovnávače)
// a preklik na dodávateľa (`internalNote`/`product_supplier_link_override`,
// rovnaká funkcia ako "Na objednanie") — bez feedovej adresy zostáva `null`
// (nikdy vyhľadávací fallback, `.claude/rules/nedostupne.md`).
it("preklik na náš e-shop + na dodávateľa: null keď appka adresu nemá, vyplnené keď má", async () => {
  const db = await boot();
  await insertTestVariantForProduct(db, "P176M-key", "P176M", { productName: "Bez odkazov" });
  const orderId1 = await insertOrder(db, "17600014");
  await db.insert(orderLines).values({ orderId: orderId1, variantCode: "P176M", quantity: 1, state: "nedostupne" });

  await insertTestVariantForProduct(db, "P176N-key", "P176N", { productName: "S odkazmi", internalNote: "https://dodavatel.example/produkt" });
  await db.insert(shopProductUrl).values({ code: "P176N", url: "https://www.forestshop.sk/p176n/", fetchedAt: new Date("2026-08-04T09:00:00Z") });
  const orderId2 = await insertOrder(db, "17600015");
  await db.insert(orderLines).values({ orderId: orderId2, variantCode: "P176N", quantity: 1, state: "nedostupne" });

  const groups = await listNedostupneGroups(db, ADMIN_BASE_URL);
  const bezOdkazov = groups.find((g) => g.variantCode === "P176M");
  expect(bezOdkazov?.ourProductUrl).toBeNull();
  expect(bezOdkazov?.supplierUrl).toBeNull();

  const sOdkazmi = groups.find((g) => g.variantCode === "P176N");
  expect(sOdkazmi?.ourProductUrl).toBe("https://www.forestshop.sk/p176n/");
  expect(sOdkazmi?.supplierUrl).toBe("https://dodavatel.example/produkt");
});

// issue 121: ručné prepísanie odkazu na dodávateľa (`product_supplier_link_override`)
// má prednosť pred extrahovaným `internalNote` — rovnaká disciplína ako
// "Na objednanie" (`resolveEffectiveSupplierLink`).
it("preklik na dodávateľa uprednostní RUČNÝ override pred extrahovaným internalNote", async () => {
  const db = await boot();
  await insertTestVariantForProduct(db, "P176O-key", "P176O", { productName: "S override-om", internalNote: "https://stary-dodavatel.example/x" });
  await db.insert(productSupplierLinkOverrides).values({ productKey: "P176O-key", url: "https://novy-dodavatel.example/y", updatedAt: new Date("2026-08-04T09:00:00Z") });
  const orderId = await insertOrder(db, "17600016");
  await db.insert(orderLines).values({ orderId, variantCode: "P176O", quantity: 1, state: "nedostupne" });

  const groups = await listNedostupneGroups(db, ADMIN_BASE_URL);
  const group = groups.find((g) => g.variantCode === "P176O");
  expect(group?.supplierUrl).toBe("https://novy-dodavatel.example/y");
});

it("preview a odoslanie použijú ROVNAKÚ funkciu (`findNedostupneContext`/`buildEmailForType`) — obsah sa nikdy nerozíde", async () => {
  const db = await boot();
  await insertTestVariantForProduct(db, "P176E", "P176E", { productName: "Bunda Test" });
  const orderId = await insertOrder(db, "17600005");
  await db.insert(orderLines).values({ orderId, variantCode: "P176E", quantity: 1, state: "nedostupne" });
  const { transport, sent } = fakeMail();

  const result = await sendNedostupneEmail({
    db,
    now: new Date("2026-08-02T10:00:00Z"),
    orderCode: "17600005",
    variantCode: "P176E",
    emailType: "nedostupne",
    mailTransport: transport,
    bccEmail: "majitel@forestshop.sk",
  });

  expect(result).toEqual({ ok: true });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe("jan@example.sk");
  expect(sent[0]?.bcc).toBe("majitel@forestshop.sk");
  expect(sent[0]?.subject).toBe("Informácia o dostupnosti vašej objednávky — Forestshop.sk");

  const [state] = await db.select().from(nedostupneState).where(eq(nedostupneState.orderCode, "17600005"));
  expect(state?.variantCode).toBe("P176E");
  expect(state?.emailType).toBe("nedostupne");
});

it("chýbajúca BCC adresa → NEPOŠLE NIČ (fail-closed, rovnaká podmienka ako #172/#173)", async () => {
  const db = await boot();
  await insertTestVariantForProduct(db, "P176F", "P176F", {});
  const orderId = await insertOrder(db, "17600006");
  await db.insert(orderLines).values({ orderId, variantCode: "P176F", quantity: 1, state: "nedostupne" });
  const { transport, sent } = fakeMail();

  const result = await sendNedostupneEmail({
    db,
    now: new Date("2026-08-02T10:00:00Z"),
    orderCode: "17600006",
    variantCode: "P176F",
    emailType: "nedostupne",
    mailTransport: transport,
    bccEmail: undefined,
  });

  expect(result.ok).toBe(false);
  expect(!result.ok && result.code).toBe("not_configured");
  expect(!result.ok && result.code === "not_configured" && result.reason).toContain("NEDOSTUPNE_BCC_EMAIL");
  expect(sent).toHaveLength(0);
});

it("chýbajúci mailTransport → NEPOŠLE NIČ (fail-closed)", async () => {
  const db = await boot();
  await insertTestVariantForProduct(db, "P176G", "P176G", {});
  const orderId = await insertOrder(db, "17600007");
  await db.insert(orderLines).values({ orderId, variantCode: "P176G", quantity: 1, state: "nedostupne" });

  const result = await sendNedostupneEmail({
    db,
    now: new Date("2026-08-02T10:00:00Z"),
    orderCode: "17600007",
    variantCode: "P176G",
    emailType: "nedostupne",
    mailTransport: undefined,
    bccEmail: "majitel@forestshop.sk",
  });

  expect(result.ok).toBe(false);
  expect(!result.ok && result.code).toBe("not_configured");
  expect(!result.ok && result.code === "not_configured" && result.reason).toContain("MAIL_HOST");
});

it("objednávka bez e-mailu → 'no_email', nikdy sa nepokúsi poslať", async () => {
  const db = await boot();
  await insertTestVariantForProduct(db, "P176H", "P176H", {});
  const orderId = await insertOrder(db, "17600008", { email: null });
  await db.insert(orderLines).values({ orderId, variantCode: "P176H", quantity: 1, state: "nedostupne" });
  const { transport, sent } = fakeMail();

  const result = await sendNedostupneEmail({
    db,
    now: new Date("2026-08-02T10:00:00Z"),
    orderCode: "17600008",
    variantCode: "P176H",
    emailType: "nedostupne",
    mailTransport: transport,
    bccEmail: "majitel@forestshop.sk",
  });

  expect(result).toEqual({ ok: false, code: "no_email" });
  expect(sent).toHaveLength(0);
});

it("DEDUP — druhé odoslanie ROVNAKÉHO (objednávka, variant, typ) je odmietnuté, žiadny druhý e-mail", async () => {
  const db = await boot();
  await insertTestVariantForProduct(db, "P176I", "P176I", {});
  const orderId = await insertOrder(db, "17600009");
  await db.insert(orderLines).values({ orderId, variantCode: "P176I", quantity: 1, state: "nedostupne" });
  const { transport, sent } = fakeMail();
  const deps = { db, now: new Date("2026-08-02T10:00:00Z"), orderCode: "17600009", variantCode: "P176I", emailType: "nedostupne" as const, mailTransport: transport, bccEmail: "majitel@forestshop.sk" };

  expect(await sendNedostupneEmail(deps)).toEqual({ ok: true });
  expect(sent).toHaveLength(1);

  const second = await sendNedostupneEmail(deps);
  expect(second).toEqual({ ok: false, code: "already_sent" });
  expect(sent).toHaveLength(1); // stále len jeden
});

it("DEDUP je NEZÁVISLÝ per typ — 'nedostupne' odoslané nebráni neskoršiemu 'alternativa'", async () => {
  const db = await boot();
  await insertTestVariantForProduct(db, "P176J", "P176J", {});
  const orderId = await insertOrder(db, "17600010");
  await db.insert(orderLines).values({ orderId, variantCode: "P176J", quantity: 1, state: "nedostupne" });
  const { transport, sent } = fakeMail();
  const base = { db, now: new Date("2026-08-02T10:00:00Z"), orderCode: "17600010", variantCode: "P176J", mailTransport: transport, bccEmail: "majitel@forestshop.sk" };

  expect(await sendNedostupneEmail({ ...base, emailType: "nedostupne" })).toEqual({ ok: true });
  expect(await sendNedostupneEmail({ ...base, emailType: "alternativa" })).toEqual({ ok: true });
  expect(sent).toHaveLength(2);
});

it("riadok, ktorý medzitým už NIE JE 'nedostupne' (napr. sklad ho medzitým naskladnil), sa odmietne pri odoslaní — 'not_found'", async () => {
  const db = await boot();
  await insertTestVariantForProduct(db, "P176K", "P176K", {});
  const orderId = await insertOrder(db, "17600011");
  await db.insert(orderLines).values({ orderId, variantCode: "P176K", quantity: 1, state: "nedostupne" });

  // Obsluha medzitým riadok prepla na "skladom" (napr. z inej karty) —
  // odoslanie MUSÍ prekontrolovať stav ZNOVA, nikdy sa nespolieha na to, že
  // zobrazený zoznam je ešte aktuálny.
  await db.update(orderLines).set({ state: "skladom" }).where(eq(orderLines.variantCode, "P176K"));
  expect(await findNedostupneContext(db, "17600011", "P176K")).toBeNull();

  const result = await sendNedostupneEmail({
    db,
    now: new Date("2026-08-02T10:00:00Z"),
    orderCode: "17600011",
    variantCode: "P176K",
    emailType: "nedostupne",
    mailTransport: undefined,
    bccEmail: undefined,
  });
  expect(result).toEqual({ ok: false, code: "not_found" });
});

// Nájdené code review pred mergom (PR #182) — bez `NEDOSTUPNE_SEND_LOCK_KEY`
// by dva súbežné klik-y na TEN ISTÝ (objednávka, variant, typ) mohli OBA
// prejsť dedup-check skôr, než ktorýkoľvek zapíše, a poslať e-mail DVAKRÁT.
// Rovnaká deterministická technika ako `posta-uncollected-run.integration
// .test.ts`/`order-reminder-run.integration.test.ts` (`pg_try_advisory_lock`
// z DRUHÉHO pripojenia, nikdy časovanie).
it("dve súbežné odoslania toho istého (objednávka, variant, typ) sa serializujú (advisory zámok), nikdy neprebehnú naraz", async () => {
  const db = await boot();
  await insertTestVariantForProduct(db, "P176L", "P176L", {});
  const orderId = await insertOrder(db, "17600012");
  await db.insert(orderLines).values({ orderId, variantCode: "P176L", quantity: 1, state: "nedostupne" });

  let releaseSend: (() => void) | undefined;
  const blockedUntilReleased = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const transport = async (): Promise<void> => {
    await blockedUntilReleased;
  };

  const sendPromise = sendNedostupneEmail({
    db,
    now: new Date("2026-08-02T10:00:00Z"),
    orderCode: "17600012",
    variantCode: "P176L",
    emailType: "nedostupne",
    mailTransport: transport,
    bccEmail: "majitel@forestshop.sk",
  });

  await new Promise((resolve) => setTimeout(resolve, 100));

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") throw new Error("DATABASE_URL chýba");
  checker = new pg.Client({ connectionString: databaseUrl });
  await checker.connect();
  const midSend = await checker.query<{ pg_try_advisory_lock: boolean }>("select pg_try_advisory_lock($1)", [NEDOSTUPNE_SEND_LOCK_KEY]);
  expect(midSend.rows[0]?.pg_try_advisory_lock).toBe(false);

  releaseSend?.();
  expect(await sendPromise).toEqual({ ok: true });

  const afterSend = await checker.query<{ pg_try_advisory_lock: boolean }>("select pg_try_advisory_lock($1)", [NEDOSTUPNE_SEND_LOCK_KEY]);
  expect(afterSend.rows[0]?.pg_try_advisory_lock).toBe(true);
  await checker.query("select pg_advisory_unlock($1)", [NEDOSTUPNE_SEND_LOCK_KEY]);
});
