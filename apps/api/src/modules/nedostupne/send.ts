import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { log } from "../../logger.js";
import { orderLines, orders, variants } from "../../db/schema.js";
import type { MailTransport } from "../mail/transport.js";
import { DUPLICATE_REASON } from "../mail-log/queries.js";
import { recordSkippedMail, sendLoggedMail, type MailLogContext } from "../mail-log/service.js";
import { resolveTemplate } from "../mail-templates/store.js";
import { listOpenStatusNames } from "../orders/open-statuses.js";
import { NEDOSTUPNE_SEND_LOCK_KEY, TYPE_ALTERNATIVE, type NedostupneEmailType } from "./constants.js";
import { renderEditedBody } from "../mail-templates/render.js";
import { buildAlternativeEmail, buildUnavailableEmail, type BuiltNedostupneEmail } from "./logic.js";
import { listReplacementLinksForVariant } from "./replacement-links.js";
import { hasSentNedostupne, markSentNedostupne } from "./state.js";

export interface NedostupneEmailContext {
  readonly orderCode: string;
  readonly variantCode: string;
  readonly customerName: string;
  readonly email: string;
  readonly itemName: string;
  // issue 238: majiteľove RUČNE vložené odkazy náhrad (nahrádza pôvodný
  // automatický `product.relatedCodes` návrh).
  readonly replacementUrls: readonly string[];
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
      customerName: orders.customerName,
      email: orders.email,
      statusName: orders.statusName,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orderLines.orderId, orders.id))
    .innerJoin(variants, eq(orderLines.variantCode, variants.code))
    .where(and(eq(orders.externalOrderId, orderCode), eq(orderLines.variantCode, variantCode), eq(orderLines.state, "nedostupne")))
    .limit(1);

  if (row === undefined || !openStatuses.includes(row.statusName)) return null;

  const replacementLinks = await listReplacementLinksForVariant(db, variantCode);
  return {
    orderCode,
    variantCode,
    customerName: row.customerName,
    email: row.email ?? "",
    itemName: row.itemName,
    replacementUrls: replacementLinks.map((l) => l.url),
  };
}

/** Rovnaká funkcia sa volá pre NÁHĽAD aj pre SKUTOČNÉ odoslanie — garantuje,
 * že sa zákazníkovi pošle PRESNE to, čo obsluha videla v náhľade. Znenie sa
 * načíta z upraviteľnej šablóny (issue 192); keď majiteľ nič neupravil, vráti
 * `resolveTemplate` pôvodné znenie z kódu. */
export async function buildEmailForType(db: Database, ctx: NedostupneEmailContext, type: NedostupneEmailType): Promise<BuiltNedostupneEmail> {
  if (type === TYPE_ALTERNATIVE) {
    const template = await resolveTemplate(db, "nedostupne_alternativa");
    return buildAlternativeEmail(template, ctx.customerName, ctx.itemName, ctx.replacementUrls);
  }
  return buildUnavailableEmail(await resolveTemplate(db, "nedostupne"), ctx.customerName);
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
  // issue 193: kto tlačidlo stlačil — táto cesta je VŽDY ručná akcia
  // zamestnanca (žiadny naplánovaný beh), takže sa zapisuje do knihy
  // odoslaných e-mailov ako `manual` s jeho menom.
  readonly actorUserId?: string;
  // issue 277: obsluha upravila text priamo v okne náhľadu — keď je
  // prítomný, PREPÍŠE vygenerované `html`/`text` (predmet ostáva pôvodný,
  // ticket edituje len text e-mailu). Šablóna v DB sa touto úpravou nikdy
  // nemení — číta sa len na zostavenie predmetu (`buildEmailForType`).
  readonly editedBody?: string;
}

/**
 * Povinný náhľad (`buildEmailForType`, volaný SAMOSTATNE cez preview
 * endpoint) predchádza KAŽDÉMU volaniu tejto funkcie z UI — appka samotná
 * to nevynucuje na úrovni servera (žiadny "preview token"), presne ako
 * #172/#173 (majiteľova bezpečnostná podmienka je fail-closed BCC/mail
 * kontrola nižšie, nie vynútený náhľad request-flow). Fail-closed: chýbajúca
 * BCC adresa ALEBO chýbajúci mail transport → NEPOŠLE NIČ (rovnaký zámer ako
 * `order-reminder/run.ts`/`posta-uncollected/run.ts`).
 *
 * Serializovaná `NEDOSTUPNE_SEND_LOCK_KEY`-om (review pred mergom, PR #182):
 * dedup-check + odoslanie + zápis stavu je BEZ zámku TOCTOU okno — dva
 * súbežné klik-y na TEN ISTÝ (objednávka, variant, typ) by mohli OBA prejsť
 * `hasSentNedostupne` skôr, než ktorýkoľvek zapíše, a poslať zákazníkovi
 * e-mail DVAKRÁT.
 */
export async function sendNedostupneEmail(options: SendNedostupneOptions): Promise<SendNedostupneResult> {
  const { db } = options;
  const lockClient = await db.$client.connect();
  try {
    await lockClient.query("select pg_advisory_lock($1)", [NEDOSTUPNE_SEND_LOCK_KEY]);
    return await sendNedostupneEmailLocked(options);
  } finally {
    await lockClient.query("select pg_advisory_unlock($1)", [NEDOSTUPNE_SEND_LOCK_KEY]);
    lockClient.release();
  }
}

async function sendNedostupneEmailLocked(options: SendNedostupneOptions): Promise<SendNedostupneResult> {
  const { db, now, orderCode, variantCode, emailType, mailTransport, bccEmail, actorUserId, editedBody } = options;

  // issue 193: každý pokus (aj neúspešný) sa zapisuje do spoločnej knihy
  // odoslaných e-mailov — `mail-log/service.ts`.
  const logCtx: MailLogContext = {
    source: "nedostupne",
    trigger: "manual",
    templateKey: emailType === TYPE_ALTERNATIVE ? "nedostupne_alternativa" : "nedostupne",
    orderCode,
    variantCode,
    ...(actorUserId === undefined ? {} : { actorUserId }),
  };

  const ctx = await findNedostupneContext(db, orderCode, variantCode);
  if (ctx === null) return { ok: false, code: "not_found" };

  const already = await hasSentNedostupne(db, orderCode, variantCode, emailType);
  if (already) {
    // Zablokovaná duplicita je to, čo ticket 193 žiada mať VIDNO v prehľade —
    // spoločný `DUPLICATE_REASON`, aby súhrn "zabránené duplicity" sedel.
    await recordSkippedMail(db, now, logCtx, ctx.email.trim(), DUPLICATE_REASON);
    return { ok: false, code: "already_sent" };
  }

  const email = ctx.email.trim();
  if (email === "") {
    await recordSkippedMail(db, now, logCtx, "", "objednávka nemá e-mailovú adresu zákazníka");
    return { ok: false, code: "no_email" };
  }

  const bccMissing = bccEmail === undefined || bccEmail.trim() === "";
  if (bccMissing) {
    const reason = "chýba adresa pre skrytú kópiu majiteľovi (NEDOSTUPNE_BCC_EMAIL)";
    await recordSkippedMail(db, now, logCtx, email, reason);
    return { ok: false, code: "not_configured", reason };
  }
  if (mailTransport === undefined) {
    const reason = "odosielanie e-mailov nie je nakonfigurované (chýba MAIL_HOST)";
    await recordSkippedMail(db, now, logCtx, email, reason);
    return { ok: false, code: "not_configured", reason };
  }

  const built = await buildEmailForType(db, ctx, emailType);
  // issue 277: obsluha mohla text v okne náhľadu upraviť — odošle sa PRESNE
  // to (predmet ostáva z pôvodného vyrenderovania), nikdy znova
  // vygenerovaná šablóna.
  const finalEmail: BuiltNedostupneEmail = editedBody === undefined ? built : { subject: built.subject, ...renderEditedBody(editedBody) };
  const sendResult = await sendLoggedMail(
    db,
    mailTransport,
    { to: email, subject: finalEmail.subject, text: finalEmail.text, html: finalEmail.html, bcc: bccEmail },
    now,
    logCtx,
  );
  if (!sendResult.ok) {
    log.error({ orderCode, variantCode, emailType, rawErrorMessage: sendResult.rawErrorMessage }, "Nedostupné tovary: odoslanie e-mailu zlyhalo");
    return { ok: false, code: "send_failed" };
  }
  // Zápis IHNEĎ po odoslaní (rovnaká disciplína ako #172/#173).
  await markSentNedostupne(db, orderCode, variantCode, emailType, now);
  log.info({ orderCode, variantCode, emailType }, "Nedostupné tovary: e-mail odoslaný");
  return { ok: true };
}
