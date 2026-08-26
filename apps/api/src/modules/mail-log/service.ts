import { and, eq, gte, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { mailLog } from "../../db/schema.js";
import { log } from "../../logger.js";
import type { MailMessage, MailTransport } from "../mail/transport.js";
import type { MailTemplateKey } from "../mail-templates/registry.js";

export type MailLogSource =
  | "nedostupne"
  | "posta_uncollected"
  | "order_reminder"
  | "supplier_order"
  | "order_merge"
  // issue 500: ručný e-mail zákazníkovi z riadku "Na objednanie".
  | "order_customer_contact";
export type MailLogTrigger = "scheduled" | "manual";

/** Spoločný popis "o čom ten e-mail bol" — každé pole je nepovinné, lebo
 * odosielatelia sa líšia (zásielka má číslo balíka, nedostupný tovar má
 * variant, objednávka dodávateľovi nemá ani jedno). */
export interface MailLogContext {
  readonly source: MailLogSource;
  readonly trigger: MailLogTrigger;
  readonly templateKey?: MailTemplateKey;
  readonly orderCode?: string;
  readonly variantCode?: string;
  readonly packageNumber?: string;
  readonly sequence?: number;
  readonly actorUserId?: string;
}

interface MailLogEntry extends MailLogContext {
  readonly status: "sent" | "failed" | "skipped";
  readonly recipient: string;
  readonly bcc?: string | undefined;
  readonly subject?: string;
  // issue 277: skutočne odoslaný/pokúšaný text — `undefined` pre `skipped`
  // (appka vtedy žiadny text nevygenerovala).
  readonly body?: string;
  readonly reason?: string;
}

async function insertEntry(db: Pick<Database, "insert">, now: Date, entry: MailLogEntry): Promise<void> {
  try {
    await db.insert(mailLog).values({
      createdAt: now,
      source: entry.source,
      status: entry.status,
      trigger: entry.trigger,
      templateKey: entry.templateKey ?? null,
      recipient: entry.recipient,
      bcc: entry.bcc ?? null,
      subject: entry.subject ?? null,
      body: entry.body ?? null,
      orderCode: entry.orderCode ?? null,
      variantCode: entry.variantCode ?? null,
      packageNumber: entry.packageNumber ?? null,
      sequence: entry.sequence ?? null,
      reason: entry.reason ?? null,
      actorUserId: entry.actorUserId ?? null,
    });
  } catch (error) {
    // Zlyhanie ZÁPISU do knihy nesmie zhodiť samotné odosielanie — e-mail už
    // je (alebo nie je) odoslaný a to je dôležitejšie než jeho záznam.
    // Zaloguje sa, aby taká strata nebola tichá.
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    log.error({ rawErrorMessage, source: entry.source, status: entry.status }, "Kniha odoslaných e-mailov: zápis zlyhal");
  }
}

/** Appka CHCELA poslať, ale nemohla — chýbajúca adresa, chýbajúce nastavenie,
 * dedup, zlyhaná AI klasifikácia. Bežné "ešte nie je čas na ďalší e-mail" sa
 * NIKDY nezapisuje: to nie je pokus, a kniha by rástla o desiatky
 * nezaujímavých riadkov denne. */
export async function recordSkippedMail(
  db: Pick<Database, "insert" | "select">,
  now: Date,
  ctx: MailLogContext,
  recipient: string,
  reason: string,
): Promise<void> {
  // Preskočenie sa OPAKUJE každý beh, kým trvá jeho príčina (objednávka bez
  // e-mailu ostane bez e-mailu aj zajtra) — bez tohto okna by kniha rástla o
  // ten istý riadok denne a prehľad by sa stal nečitateľným. 24 h = najviac
  // jeden riadok za deň na (automatizácia, objednávka, dôvod).
  const since = new Date(now.getTime() - SKIP_DEDUP_WINDOW_MS);
  const existing = await db
    .select({ id: mailLog.id })
    .from(mailLog)
    .where(
      and(
        eq(mailLog.source, ctx.source),
        eq(mailLog.status, "skipped"),
        eq(mailLog.reason, reason),
        ctx.orderCode === undefined ? isNull(mailLog.orderCode) : eq(mailLog.orderCode, ctx.orderCode),
        gte(mailLog.createdAt, since),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;
  await insertEntry(db, now, { ...ctx, status: "skipped", recipient, reason });
}

export const SKIP_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SendLoggedMailResult = { readonly ok: true } | { readonly ok: false; readonly rawErrorMessage: string };

/**
 * JEDINÁ cesta, akou appka posiela e-mail zákazníkovi/dodávateľovi. Odoslanie
 * a zápis do knihy sú tu zámerne SPOJENÉ v jednej funkcii — keby si každý
 * odosielateľ zapisoval sám, ďalšia automatizácia by sa dala pridať tak, že
 * na zápis zabudne, a majiteľ by o jej pošte nevedel (presne to bol stav pred
 * issue 193 pri všetkých štyroch odosielateľoch naraz).
 *
 * Nevyhadzuje výnimku — volajúci sa rozhoduje podľa `ok`, presne ako to robil
 * so svojím vlastným `try/catch` predtým.
 */
export async function sendLoggedMail(
  db: Pick<Database, "insert">,
  transport: MailTransport,
  message: MailMessage,
  now: Date,
  ctx: MailLogContext,
): Promise<SendLoggedMailResult> {
  try {
    await transport(message);
  } catch (error) {
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    await insertEntry(db, now, {
      ...ctx,
      status: "failed",
      recipient: message.to,
      bcc: message.bcc,
      subject: message.subject,
      body: message.text,
      reason: rawErrorMessage,
    });
    return { ok: false, rawErrorMessage };
  }
  await insertEntry(db, now, { ...ctx, status: "sent", recipient: message.to, bcc: message.bcc, subject: message.subject, body: message.text });
  return { ok: true };
}
