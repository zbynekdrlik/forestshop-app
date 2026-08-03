import type { Database } from "../../db/client.js";
import { log } from "../../logger.js";
import type { MailTransport } from "../mail/transport.js";
import { buildShoptetAdminOrderUrl } from "../orders/queries.js";
import type { ClassifyClient } from "./classify-client.js";
import { ORDER_REMINDER_RUN_LOCK_KEY } from "./constants.js";
import { resolveTemplate } from "../mail-templates/store.js";
import { buildReminderEmail, daysOpen, fingerprint, isOldEnough, type ReminderEligibleOrder } from "./logic.js";
import { loadEligibleOrders, loadItemLabels } from "./orders-source.js";
import {
  loadOrderReminderState,
  loadOrderReminderStateOne,
  upsertOrderReminderState,
  pruneOrderReminderState,
  type OrderReminderResolution,
  type OrderReminderResolvedBy,
} from "./state.js";

export interface OrderReminderRow {
  readonly orderCode: string;
  readonly adminLink: string;
  readonly name: string;
  readonly phone: string;
  readonly email: string;
  readonly itemLabel: string;
  readonly days: number;
}

export interface OrderReminderResolvedRow extends OrderReminderRow {
  readonly resolvedAt: string;
  readonly resolvedBy: OrderReminderResolvedBy;
}

export interface OrderReminderPendingRow extends OrderReminderRow {
  readonly reason: string;
}

export interface OrderReminderRunResult {
  readonly checkedAt: string;
  // 🔴 bez poznámky — e-mail sa NEPOSIELA nikdy z tejto vetvy.
  readonly noNote: readonly OrderReminderRow[];
  // ✉️ bez e-mailovej adresy — AI sa vôbec nepýta (šetrí peniaze).
  readonly noEmail: readonly OrderReminderRow[];
  // 🟠 pripomienka odoslaná (AI aj ručne).
  readonly emailed: readonly OrderReminderResolvedRow[];
  // ⚪/✋ zákazník už kontaktovaný (AI aj ručne).
  readonly contacted: readonly OrderReminderResolvedRow[];
  // ⚠️ automatika začala, ale nedokončila (chýbajúce nastavenie/zlyhanie).
  readonly pending: readonly OrderReminderPendingRow[];
  readonly aiNotConfigured: boolean;
  readonly bccMissing: boolean;
  readonly mailNotConfigured: boolean;
  readonly stats: {
    readonly candidates: number;
    readonly noNoteCount: number;
    readonly noEmailCount: number;
    readonly emailedNow: number;
    readonly contactedNow: number;
    readonly pendingCount: number;
  };
}

export interface RunOrderReminderOptions {
  readonly db: Database;
  readonly now: Date;
  readonly classifyClient: ClassifyClient | undefined;
  readonly mailTransport: MailTransport | undefined;
  readonly bccEmail: string | undefined;
  readonly adminBaseUrl: string;
}

function toRow(order: ReminderEligibleOrder, itemLabels: ReadonlyMap<string, string>, adminBaseUrl: string, now: Date): OrderReminderRow {
  return {
    orderCode: order.externalOrderId,
    adminLink: buildShoptetAdminOrderUrl(adminBaseUrl, order.externalOrderId, order.shoptetOrderId),
    name: order.customerName,
    phone: order.phone ?? "",
    email: order.email ?? "",
    itemLabel: itemLabels.get(order.externalOrderId) ?? "",
    days: daysOpen(order.placedAt, now),
  };
}

export async function runOrderReminder(options: RunOrderReminderOptions): Promise<OrderReminderRunResult> {
  const { db } = options;
  const lockClient = await db.$client.connect();
  try {
    await lockClient.query("select pg_advisory_lock($1)", [ORDER_REMINDER_RUN_LOCK_KEY]);
    return await runOrderReminderLocked(options);
  } finally {
    await lockClient.query("select pg_advisory_unlock($1)", [ORDER_REMINDER_RUN_LOCK_KEY]);
    lockClient.release();
  }
}

async function runOrderReminderLocked(options: RunOrderReminderOptions): Promise<OrderReminderRunResult> {
  const { db, now, classifyClient, mailTransport, bccEmail, adminBaseUrl } = options;
  const eligible = await loadEligibleOrders(db);
  const candidates = eligible.filter((o) => isOldEnough(o.placedAt, now));
  const codes = candidates.map((c) => c.externalOrderId);
  const [stateMap, itemLabels] = await Promise.all([loadOrderReminderState(db, codes), loadItemLabels(db, codes)]);

  const noNote: OrderReminderRow[] = [];
  const noEmail: OrderReminderRow[] = [];
  const emailed: OrderReminderResolvedRow[] = [];
  const contacted: OrderReminderResolvedRow[] = [];
  const pending: OrderReminderPendingRow[] = [];
  const aiNotConfigured = classifyClient === undefined;
  const bccMissing = bccEmail === undefined || bccEmail.trim() === "";
  const mailNotConfigured = mailTransport === undefined;
  let emailedNow = 0;
  let contactedNow = 0;

  const resolvedRow = (
    order: ReminderEligibleOrder,
    resolution: OrderReminderResolution,
    resolvedBy: OrderReminderResolvedBy,
    resolvedAt: Date,
  ): OrderReminderResolvedRow => ({
    ...toRow(order, itemLabels, adminBaseUrl, now),
    resolvedAt: resolvedAt.toISOString(),
    resolvedBy,
  });

  // Šablóna sa načíta RAZ pred cyklom (issue 192) — jeden beh smie poslať
  // desiatky e-mailov a znenie sa počas neho meniť nemá.
  const reminderTemplate = await resolveTemplate(db, "order_reminder");

  for (const order of candidates) {
    const fp = fingerprint(order);
    const existing = stateMap.get(order.externalOrderId);

    // Ticket: "objednávka, ktorá už bola vybavená ... sa znovu nespracúva —
    // appka si len obnoví počet dní." RESOLUTION JE TRVALÉ, VŽDY — nielen
    // keď sa odtlačok zhoduje. Overené priamo v starej appke's
    // `run_orders_reminder` (`webreview/app.py:9013`): jej vlastný
    // `_reminder_is_terminal(prev)` skrat beží PRE has_note/e-mail/AI
    // kontrolami pre KAŽDÚ objednávku vo `to_process` (teda aj tie, čo
    // partition_incremental poslalo ďalej práve PRETO, že sa odtlačok
    // zmenil) — fingerprint tam rozhoduje LEN o tom, či sa vôbec oplatí
    // prepočítavať zobrazovacie polia (rýchla vs. pomalá cesta), NIKDY o
    // tom, či sa smie poslať druhý e-mail alebo prehodnotiť AI verdikt.
    // Bez tohto by zmena poznámky PO odoslaní e-mailu poslala DRUHÝ e-mail
    // (porušenie ticketovej "presne jeden e-mail, navždy" podmienky).
    if (existing?.resolution !== undefined && existing.resolution !== null) {
      const row = resolvedRow(order, existing.resolution, existing.resolvedBy ?? "ai", existing.resolvedAt ?? now);
      (existing.resolution === "emailed" ? emailed : contacted).push(row);
      continue;
    }

    const note = (order.shopRemark ?? "").trim();
    if (note === "") {
      // Čistý stavový automat (ticket's oprava starej appky): bez poznámky
      // = LEN červené upozornenie, e-mail sa NEPOSIELA nikdy z tejto vetvy.
      noNote.push(toRow(order, itemLabels, adminBaseUrl, now));
      continue;
    }

    const email = (order.email ?? "").trim();
    if (email === "") {
      // Bez adresy sa pripomienka nikdy nedá poslať — AI sa nepýta (šetrí
      // peniaze), objednávka nikdy nedosiahne terminálny stav samovoľne.
      noEmail.push(toRow(order, itemLabels, adminBaseUrl, now));
      continue;
    }

    if (aiNotConfigured) {
      pending.push({ ...toRow(order, itemLabels, adminBaseUrl, now), reason: "AI klasifikácia nedostupná — chýba OPENAI_API_KEY" });
      continue;
    }
    if (bccMissing) {
      pending.push({
        ...toRow(order, itemLabels, adminBaseUrl, now),
        reason: "chýba adresa pre skrytú kópiu majiteľovi (ORDER_REMINDER_BCC_EMAIL)",
      });
      continue;
    }
    if (mailNotConfigured) {
      pending.push({ ...toRow(order, itemLabels, adminBaseUrl, now), reason: "odosielanie e-mailov nie je nakonfigurované (chýba MAIL_HOST)" });
      continue;
    }

    let isContacted: boolean;
    try {
      isContacted = await classifyClient(order.shopRemark);
    } catch (error) {
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      log.error({ orderCode: order.externalOrderId, rawErrorMessage }, "Pripomienky objednávok: AI klasifikácia zlyhala");
      pending.push({ ...toRow(order, itemLabels, adminBaseUrl, now), reason: "AI klasifikácia zlyhala — skúsi sa znova nabudúce" });
      continue;
    }

    if (isContacted) {
      await upsertOrderReminderState(db, { orderCode: order.externalOrderId, fingerprint: fp, resolution: "contacted", resolvedBy: "ai", resolvedAt: now }, now);
      contactedNow += 1;
      contacted.push(resolvedRow(order, "contacted", "ai", now));
      continue;
    }

    const built = buildReminderEmail(reminderTemplate, order.customerName, order.externalOrderId);
    try {
      await mailTransport({ to: email, subject: built.subject, text: built.text, html: built.html, bcc: bccEmail });
      // Zápis IHNEĎ po odoslaní — pád appky neskôr v behu nesmie stratiť
      // dôkaz o už odoslanom e-maile (rovnaká disciplína ako #172).
      await upsertOrderReminderState(db, { orderCode: order.externalOrderId, fingerprint: fp, resolution: "emailed", resolvedBy: "ai", resolvedAt: now }, now);
      emailedNow += 1;
      emailed.push(resolvedRow(order, "emailed", "ai", now));
    } catch (error) {
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      log.error({ orderCode: order.externalOrderId, rawErrorMessage }, "Pripomienky objednávok: odoslanie e-mailu zlyhalo");
      pending.push({ ...toRow(order, itemLabels, adminBaseUrl, now), reason: "odoslanie e-mailu zlyhalo — skúsi sa znova nabudúce" });
    }
  }

  const prunedCount = await pruneOrderReminderState(db, eligible.map((o) => o.externalOrderId));
  if (prunedCount > 0) {
    log.info({ prunedCount }, "Pripomienky objednávok: vyčistené záznamy objednávok mimo otvorených stavov");
  }

  return {
    checkedAt: now.toISOString(),
    noNote,
    noEmail,
    emailed,
    contacted,
    pending,
    aiNotConfigured,
    bccMissing,
    mailNotConfigured,
    stats: {
      candidates: candidates.length,
      noNoteCount: noNote.length,
      noEmailCount: noEmail.length,
      emailedNow,
      contactedNow,
      pendingCount: pending.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Ručný per-riadkový override ("▶ Poslať pripomienku" / "✓ Kontaktované") —
// rovnaký advisory zámok ako celý beh vyššie (návrhový komentár na issue 173:
// Postgres serializácia nahrádza starej appky's súborový claim+TTL
// mechanizmus). Dovolené z akéhokoľvek NEuzavretého stavu (nič, alebo
// 'contacted' — oprava zlej AI verdiktu), NIKDY z už 'emailed' (žiadny druhý
// mail).

export type OrderReminderOverrideAction = "contact" | "send";

export type OrderReminderOverrideResult =
  | { readonly ok: true; readonly resolution: OrderReminderResolution }
  | { readonly ok: false; readonly code: "not_found" }
  | { readonly ok: false; readonly code: "already_resolved"; readonly resolution: OrderReminderResolution }
  | { readonly ok: false; readonly code: "no_email" }
  | { readonly ok: false; readonly code: "not_configured"; readonly reason: string }
  | { readonly ok: false; readonly code: "send_failed" };

export interface RunOrderReminderOverrideOptions extends RunOrderReminderOptions {
  readonly orderCode: string;
  readonly action: OrderReminderOverrideAction;
}

export async function runOrderReminderOverride(options: RunOrderReminderOverrideOptions): Promise<OrderReminderOverrideResult> {
  const { db } = options;
  const lockClient = await db.$client.connect();
  try {
    await lockClient.query("select pg_advisory_lock($1)", [ORDER_REMINDER_RUN_LOCK_KEY]);
    return await runOrderReminderOverrideLocked(options);
  } finally {
    await lockClient.query("select pg_advisory_unlock($1)", [ORDER_REMINDER_RUN_LOCK_KEY]);
    lockClient.release();
  }
}

async function runOrderReminderOverrideLocked(options: RunOrderReminderOverrideOptions): Promise<OrderReminderOverrideResult> {
  const { db, now, orderCode, action, mailTransport, bccEmail } = options;
  const eligible = await loadEligibleOrders(db);
  const order = eligible.find((o) => o.externalOrderId === orderCode);
  if (order === undefined) return { ok: false, code: "not_found" };

  const existing = await loadOrderReminderStateOne(db, orderCode);
  if (existing?.resolution === "emailed") {
    return { ok: false, code: "already_resolved", resolution: "emailed" };
  }
  if (action === "contact" && existing?.resolution === "contacted") {
    return { ok: false, code: "already_resolved", resolution: "contacted" };
  }

  const fp = fingerprint(order);
  if (action === "contact") {
    await upsertOrderReminderState(db, { orderCode, fingerprint: fp, resolution: "contacted", resolvedBy: "manual", resolvedAt: now }, now);
    log.info({ orderCode }, "Pripomienky objednávok: ručné označenie kontaktované");
    return { ok: true, resolution: "contacted" };
  }

  // action === "send" — dovolené aj cez wrongly-'contacted' AI verdikt.
  const email = (order.email ?? "").trim();
  if (email === "") return { ok: false, code: "no_email" };
  const bccMissing = bccEmail === undefined || bccEmail.trim() === "";
  if (bccMissing) return { ok: false, code: "not_configured", reason: "chýba adresa pre skrytú kópiu majiteľovi (ORDER_REMINDER_BCC_EMAIL)" };
  if (mailTransport === undefined) return { ok: false, code: "not_configured", reason: "odosielanie e-mailov nie je nakonfigurované (chýba MAIL_HOST)" };

  const built = buildReminderEmail(await resolveTemplate(db, "order_reminder"), order.customerName, orderCode);
  try {
    await mailTransport({ to: email, subject: built.subject, text: built.text, html: built.html, bcc: bccEmail });
  } catch (error) {
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    log.error({ orderCode, rawErrorMessage }, "Pripomienky objednávok: ručné odoslanie zlyhalo");
    return { ok: false, code: "send_failed" };
  }
  await upsertOrderReminderState(db, { orderCode, fingerprint: fp, resolution: "emailed", resolvedBy: "manual", resolvedAt: now }, now);
  log.info({ orderCode }, "Pripomienky objednávok: ručné odoslanie");
  return { ok: true, resolution: "emailed" };
}
