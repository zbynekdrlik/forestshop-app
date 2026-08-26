import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orders } from "../../db/schema.js";
import { log } from "../../logger.js";
import { recordSkippedMail, sendLoggedMail, type MailLogContext } from "../mail-log/service.js";
import { globalContext, textValue } from "../mail-templates/context.js";
import { renderEditedBody, renderTemplate } from "../mail-templates/render.js";
import { resolveTemplate } from "../mail-templates/store.js";
import type { MailTransport } from "../mail/transport.js";

// issue 500: ručný e-mail zákazníkovi z riadku „Na objednanie" (@ tlačidlo v
// stĺpci DODÁVATEĽ). Zámerne úzko zrkadlí „Zlúčenie objednávok"
// (`merge-mail.ts`) — objednávkovo-viazaný zákaznícky e-mail cez JEDINÚ
// odosielaciu cestu F193 (`sendLoggedMail`), upraviteľnú šablónu F192
// (`resolveTemplate`) a povinný náhľad pred odoslaním
// (`customer-contact-preview-tokens.ts`, vynútené v routách). Na rozdiel od
// `nedostupne` NEMÁ žiadnu dedup/stavovú tabuľku ani advisory zámok — je to
// bežná ručná akcia zamestnanca, žiadne „už raz odoslané" pravidlo; jedinú
// pretekársku situáciu (dvojklik) rieši jednorazová spotreba preview tokenu.

export interface CustomerContactContext {
  readonly orderCode: string;
  readonly customerName: string;
  // "" keď objednávka nemá e-mail zákazníka — appka email nikdy needukuje, len
  // prenáša (rovnaký zámer ako `nedostupne`'s `NedostupneEmailContext`).
  readonly email: string;
}

/** Nájde objednávku podľa jej Shoptet čísla (`externalOrderId`, unikátne) a
 * vytiahne meno + e-mail zákazníka. `null` = objednávka sa nenašla. */
export async function findCustomerContactContext(db: Database, orderCode: string): Promise<CustomerContactContext | null> {
  const [row] = await db
    .select({ customerName: orders.customerName, email: orders.email })
    .from(orders)
    .where(eq(orders.externalOrderId, orderCode))
    .limit(1);
  if (row === undefined) return null;
  return { orderCode, customerName: row.customerName, email: row.email ?? "" };
}

export interface CustomerContactMailContent {
  readonly to: string | null;
  readonly customerName: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** Náhľad aj odoslanie skladajú obsah TOU ISTOU cestou — garantuje, že sa
 * zákazníkovi pošle PRESNE to, čo obsluha videla v náhľade. Znenie sa načíta z
 * upraviteľnej šablóny (F192); keď majiteľ nič neupravil, vráti `resolveTemplate`
 * pôvodné znenie z kódu. */
export async function buildCustomerContactMail(db: Database, ctx: CustomerContactContext): Promise<CustomerContactMailContent> {
  const template = await resolveTemplate(db, "order_customer_contact");
  const rendered = renderTemplate(template, {
    ...globalContext(),
    meno_zakaznika: textValue(ctx.customerName),
    cislo_objednavky: textValue(ctx.orderCode),
  });
  const trimmedEmail = ctx.email.trim();
  return {
    to: trimmedEmail === "" ? null : trimmedEmail,
    customerName: ctx.customerName,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  };
}

export type SendCustomerContactResult =
  | { readonly status: "sent"; readonly to: string }
  | { readonly status: "not_found" }
  | { readonly status: "no_email" }
  | { readonly status: "not_configured"; readonly reason: string }
  | { readonly status: "send_failed" };

export interface SendCustomerContactOptions {
  readonly db: Database;
  readonly now: Date;
  readonly orderCode: string;
  readonly mailTransport: MailTransport | undefined;
  readonly bccEmail: string | undefined;
  // issue 193: kto tlačidlo stlačil — táto cesta je VŽDY ručná akcia
  // zamestnanca (žiadny naplánovaný beh), zapisuje sa do knihy ako `manual`.
  readonly actorUserId?: string;
  // issue 277: obsluha upravila text priamo v okne náhľadu — keď je prítomný,
  // PREPÍŠE vygenerované `html`/`text` (predmet ostáva pôvodný). Šablóna v DB sa
  // touto úpravou nikdy nemení.
  readonly editedBody?: string;
}

/**
 * Fail-closed: chýbajúca BCC adresa ALEBO chýbajúci mail transport → NEPOŠLE
 * NIČ (rovnaký zámer ako `nedostupne`/`order-merge` — majiteľova podmienka
 * „všade nech je BCC, keď niečo posiela mail"). Žiadny advisory zámok — na
 * rozdiel od `nedostupne` tu neexistuje „už raz odoslané" business pravidlo;
 * dvojklik na TO ISTÉ odoslanie je už vyriešený jednorazovou spotrebou preview
 * tokenu (`customer-contact-preview-tokens.ts`, vynútené v routách).
 */
export async function sendCustomerContactMail(options: SendCustomerContactOptions): Promise<SendCustomerContactResult> {
  const { db, now, orderCode, mailTransport, bccEmail, actorUserId, editedBody } = options;

  const logCtx: MailLogContext = {
    source: "order_customer_contact",
    trigger: "manual",
    templateKey: "order_customer_contact",
    orderCode,
    ...(actorUserId === undefined ? {} : { actorUserId }),
  };

  const ctx = await findCustomerContactContext(db, orderCode);
  if (ctx === null) return { status: "not_found" };

  const built = await buildCustomerContactMail(db, ctx);
  const { to } = built;
  if (to === null) {
    await recordSkippedMail(db, now, logCtx, "", "objednávka nemá e-mailovú adresu zákazníka");
    return { status: "no_email" };
  }

  const bccMissing = bccEmail === undefined || bccEmail.trim() === "";
  if (bccMissing) {
    const reason = "chýba adresa pre skrytú kópiu majiteľovi (ORDER_CUSTOMER_CONTACT_BCC_EMAIL)";
    await recordSkippedMail(db, now, logCtx, to, reason);
    return { status: "not_configured", reason };
  }
  if (mailTransport === undefined) {
    const reason = "odosielanie e-mailov nie je nakonfigurované (chýba MAIL_HOST)";
    await recordSkippedMail(db, now, logCtx, to, reason);
    return { status: "not_configured", reason };
  }

  // issue 277: obsluha mohla text v okne náhľadu upraviť — odošle sa PRESNE to
  // (predmet ostáva z pôvodného vyrenderovania), nikdy znova vygenerovaná
  // šablóna.
  const finalContent = editedBody === undefined ? built : { ...built, ...renderEditedBody(editedBody) };
  const sendResult = await sendLoggedMail(
    db,
    mailTransport,
    { to, subject: built.subject, text: finalContent.text, html: finalContent.html, bcc: bccEmail },
    now,
    logCtx,
  );
  if (!sendResult.ok) {
    log.error({ orderCode, rawErrorMessage: sendResult.rawErrorMessage }, "Kontakt zákazníkovi: odoslanie e-mailu zlyhalo");
    return { status: "send_failed" };
  }
  log.info({ orderCode }, "Kontakt zákazníkovi: e-mail odoslaný");
  return { status: "sent", to };
}
