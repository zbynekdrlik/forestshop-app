import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { log } from "../../logger.js";
import { orderLines, orders, products, variants } from "../../db/schema.js";
import type { MailTransport } from "../mail/transport.js";
import { listOpenStatusNames } from "../orders/open-statuses.js";
import { TYPE_ALTERNATIVE, type NedostupneEmailType } from "./constants.js";
import { buildAlternativeEmail, buildAlternatives, buildUnavailableEmail, type BuiltNedostupneEmail, type EmailAlternative } from "./logic.js";
import { resolveAlternativeNames } from "./queries.js";
import { hasSentNedostupne, markSentNedostupne } from "./state.js";

export interface NedostupneEmailContext {
  readonly orderCode: string;
  readonly variantCode: string;
  readonly customerName: string;
  readonly email: string;
  readonly itemName: string;
  readonly alternatives: readonly EmailAlternative[];
}

/**
 * Nájde presne JEDEN (objednávka, variant) riadok, PRE KTORÝ smie appka
 * poslať/zobraziť náhľad e-mailu — vyžaduje, aby bol riadok STÁLE v stave
 * `nedostupne` A objednávka STÁLE v otvorenom stave (obranná
 * PREKONTROLA priamo pred odoslaním, nikdy sa nespolieha na to, že
 * zobrazený zoznam v prehliadači je ešte aktuálny — riadok mohol medzitým
 * prejsť do iného stavu). `null` = riadok sa nenašiel/už nie je eligible.
 */
export async function findNedostupneContext(db: Database, orderCode: string, variantCode: string): Promise<NedostupneEmailContext | null> {
  const openStatuses = await listOpenStatusNames(db);
  if (openStatuses.length === 0) return null;

  const [row] = await db
    .select({
      itemName: variants.name,
      relatedCodes: products.relatedCodes,
      customerName: orders.customerName,
      email: orders.email,
      statusName: orders.statusName,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orderLines.orderId, orders.id))
    .innerJoin(variants, eq(orderLines.variantCode, variants.code))
    .innerJoin(products, eq(variants.productKey, products.key))
    .where(and(eq(orders.externalOrderId, orderCode), eq(orderLines.variantCode, variantCode), eq(orderLines.state, "nedostupne")))
    .limit(1);

  if (row === undefined || !openStatuses.includes(row.statusName)) return null;

  const names = await resolveAlternativeNames(db, row.relatedCodes ?? []);
  return {
    orderCode,
    variantCode,
    customerName: row.customerName,
    email: row.email ?? "",
    itemName: row.itemName,
    alternatives: buildAlternatives(row.relatedCodes ?? [], names),
  };
}

/** Rovnaká funkcia sa volá pre NÁHĽAD aj pre SKUTOČNÉ odoslanie — garantuje,
 * že sa zákazníkovi pošle PRESNE to, čo obsluha videla v náhľade. */
export function buildEmailForType(ctx: NedostupneEmailContext, type: NedostupneEmailType): BuiltNedostupneEmail {
  return type === TYPE_ALTERNATIVE ? buildAlternativeEmail(ctx.customerName, ctx.itemName, ctx.alternatives) : buildUnavailableEmail(ctx.customerName);
}

export type SendNedostupneResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "not_found" }
  | { readonly ok: false; readonly code: "already_sent" }
  | { readonly ok: false; readonly code: "no_email" }
  | { readonly ok: false; readonly code: "not_configured"; readonly reason: string }
  | { readonly ok: false; readonly code: "send_failed" };

export interface SendNedostupneOptions {
  readonly db: Database;
  readonly now: Date;
  readonly orderCode: string;
  readonly variantCode: string;
  readonly emailType: NedostupneEmailType;
  readonly mailTransport: MailTransport | undefined;
  readonly bccEmail: string | undefined;
}

/**
 * Povinný náhľad (`buildEmailForType`, volaný SAMOSTATNE cez preview
 * endpoint) predchádza KAŽDÉMU volaniu tejto funkcie z UI — appka samotná
 * to nevynucuje na úrovni servera (žiadny "preview token"), presne ako
 * #172/#173 (majiteľova bezpečnostná podmienka je fail-closed BCC/mail
 * kontrola nižšie, nie vynútený náhľad request-flow). Fail-closed: chýbajúca
 * BCC adresa ALEBO chýbajúci mail transport → NEPOŠLE NIČ (rovnaký zámer ako
 * `order-reminder/run.ts`/`posta-uncollected/run.ts`).
 */
export async function sendNedostupneEmail(options: SendNedostupneOptions): Promise<SendNedostupneResult> {
  const { db, now, orderCode, variantCode, emailType, mailTransport, bccEmail } = options;

  const ctx = await findNedostupneContext(db, orderCode, variantCode);
  if (ctx === null) return { ok: false, code: "not_found" };

  const already = await hasSentNedostupne(db, orderCode, variantCode, emailType);
  if (already) return { ok: false, code: "already_sent" };

  const email = ctx.email.trim();
  if (email === "") return { ok: false, code: "no_email" };

  const bccMissing = bccEmail === undefined || bccEmail.trim() === "";
  if (bccMissing) return { ok: false, code: "not_configured", reason: "chýba adresa pre skrytú kópiu majiteľovi (NEDOSTUPNE_BCC_EMAIL)" };
  if (mailTransport === undefined) return { ok: false, code: "not_configured", reason: "odosielanie e-mailov nie je nakonfigurované (chýba MAIL_HOST)" };

  const built = buildEmailForType(ctx, emailType);
  try {
    await mailTransport({ to: email, subject: built.subject, text: built.text, html: built.html, bcc: bccEmail });
  } catch (error) {
    const rawErrorMessage = error instanceof Error ? error.message : String(error);
    log.error({ orderCode, variantCode, emailType, rawErrorMessage }, "Nedostupné tovary: odoslanie e-mailu zlyhalo");
    return { ok: false, code: "send_failed" };
  }
  // Zápis IHNEĎ po odoslaní (rovnaká disciplína ako #172/#173).
  await markSentNedostupne(db, orderCode, variantCode, emailType, now);
  log.info({ orderCode, variantCode, emailType }, "Nedostupné tovary: e-mail odoslaný");
  return { ok: true };
}
