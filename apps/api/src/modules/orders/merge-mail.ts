import { inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { orders } from "../../db/schema.js";
import { log } from "../../logger.js";
import { recordSkippedMail, sendLoggedMail, type MailLogContext } from "../mail-log/service.js";
import { globalContext, textValue } from "../mail-templates/context.js";
import { renderEditedBody, renderTemplate } from "../mail-templates/render.js";
import { resolveTemplate } from "../mail-templates/store.js";
import type { MailTransport } from "../mail/transport.js";
import { customerIdentityKey } from "./customer-identity.js";
import { listOpenStatusNames } from "./open-statuses.js";
import { buildShoptetAdminOrderUrl } from "./queries.js";

// issue 257: e-mail zákazníkovi, keď sa jeho viaceré objednávky posielajú
// spolu ako jedna zásielka. "Ten istý zákazník" = zdieľaný `customerIdentityKey`
// (`customer-identity.js`) — tú istú definíciu používa aj odznak počtu
// otvorených objednávok v "Na objednanie" (#431), aby sa nerozišli.

export interface MergeCandidateOrder {
  readonly orderId: string;
  readonly externalOrderId: string;
  readonly placedAt: string;
}

// issue 512: kandidát vo VÝPISE záložky navyše nesie priamy odkaz do Shoptet
// administrácie na TÚTO objednávku (`buildShoptetAdminOrderUrl` — ten istý
// serverom-počítaný `adminUrl` string ako „Na objednanie"/„Riešiť"/„Vyhľadať")
// — LEN pre klikateľné čísla objednávok vo výpise; send/preview tok
// (`listMergeableOrders`) ho nepotrebuje, preto zostáva na holom
// `MergeCandidateOrder`.
export interface MergeCandidateGroupOrder extends MergeCandidateOrder {
  readonly adminUrl: string;
}

export interface MergeableOrders {
  readonly orderId: string;
  readonly externalOrderId: string;
  readonly customerName: string;
  // `null`/prázdne — appka email nikdy needukuje, len prenáša (rovnaký zámer
  // ako `nedostupne`'s `NedostupneEmailContext`).
  readonly email: string | null;
  readonly candidates: readonly MergeCandidateOrder[];
}

// issue 257 (majiteľova korekcia, 2026-08-05): "malo by to byt zalozka v
// eshope a mali by tam vyskocit ak su dve objedanvky na toho isteho
// zakaznika" — záložka potrebuje vypísať VŠETKÝCH kandidátov naraz, nie
// len kandidátov PRE jednu už vybranú objednávku (`listMergeableOrders`
// vyššie zostáva, používa ho `buildOrderMergeMailContent` nižšie).
export interface MergeCandidateGroup {
  readonly customerName: string;
  readonly email: string | null;
  // Najnovšia objednávka prvá — rovnaké poradie ako `listMergeableOrders`'s
  // `candidates`. Prvý prvok slúži ako `baseOrderId` pri odoslaní (server aj
  // tak celú skupinu prepočíta nanovo podľa identity zákazníka, takže na
  // tom, KTORÁ objednávka skupiny je "base", nezáleží).
  readonly orders: readonly MergeCandidateGroupOrder[];
}

/**
 * Otvorené objednávky zoskupené podľa IDENTITY zákazníka
 * (`customerIdentityKey`), len skupiny s ≥2 objednávkami. Vnútri skupiny
 * najnovšia objednávka prvá; skupiny zoradené od NAJVÄČŠEJ (najviac
 * objednávok na zlúčenie), pri zhode abecedne podľa mena.
 *
 * issue 512: JEDINÝ zdroj pravdy pre „ktorí zákazníci sa dajú zlúčiť" —
 * zdieľajú ho VÝPIS (`listMergeCandidateGroups`) AJ POČET pre menu odznak
 * (`countMergeCandidateGroups`), aby sa odznak (počet prípadov) a samotné
 * zlúčenie NIKDY nerozišli (rovnaká úvaha ako odznak „Na objednanie", #431).
 */
function groupOpenOrdersByCustomer(openOrders: readonly OpenOrderRow[]): OpenOrderRow[][] {
  const byIdentity = new Map<string, OpenOrderRow[]>();
  for (const order of openOrders) {
    const key = customerIdentityKey(order.email, order.customerName);
    const bucket = byIdentity.get(key);
    if (bucket === undefined) byIdentity.set(key, [order]);
    else bucket.push(order);
  }
  const buckets: OpenOrderRow[][] = [];
  for (const bucket of byIdentity.values()) {
    if (bucket.length < 2) continue;
    buckets.push([...bucket].sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime()));
  }
  buckets.sort(
    (a, b) => b.length - a.length || (a[0]?.customerName ?? "").localeCompare(b[0]?.customerName ?? "", "sk"),
  );
  return buckets;
}

/**
 * Zákazníci s ≥2 OTVORENÝMI objednávkami — presne zoznam, ktorý nová
 * záložka "Zlúčenie objednávok" vypíše. `adminBaseUrl` (`env.ts`'s
 * `SHOPTET_ADMIN_BASE_URL`) je základ priameho odkazu na objednávku
 * (issue 512, klikateľné čísla — ten istý `buildShoptetAdminOrderUrl` ako
 * „Na objednanie"/„Riešiť"/„Vyhľadať").
 */
export async function listMergeCandidateGroups(
  db: Database,
  adminBaseUrl: string,
): Promise<readonly MergeCandidateGroup[]> {
  const buckets = groupOpenOrdersByCustomer(await loadOpenOrders(db));
  const groups: MergeCandidateGroup[] = [];
  for (const bucket of buckets) {
    const first = bucket[0];
    if (first === undefined) continue;
    groups.push({
      customerName: first.customerName,
      email: first.email,
      orders: bucket.map((o) => ({
        orderId: o.id,
        externalOrderId: o.externalOrderId,
        placedAt: o.placedAt.toISOString(),
        adminUrl: buildShoptetAdminOrderUrl(adminBaseUrl, o.externalOrderId, o.shoptetOrderId),
      })),
    });
  }
  return groups;
}

/**
 * issue 512: počet PRÍPADOV pre menu odznak — zákazníci (osoby) s ≥2
 * otvorenými objednávkami, NIE počet objednávok (Jozef Stroška s 3
 * objednávkami = 1). Zdieľa `groupOpenOrdersByCustomer` s výpisom vyššie,
 * takže odznak a zlúčenie sa nikdy nerozídu; nepotrebuje `adminBaseUrl`
 * (len počíta skupiny).
 */
export async function countMergeCandidateGroups(db: Database): Promise<number> {
  return groupOpenOrdersByCustomer(await loadOpenOrders(db)).length;
}

interface OpenOrderRow {
  readonly id: string;
  readonly externalOrderId: string;
  readonly customerName: string;
  readonly email: string | null;
  readonly placedAt: Date;
  // issue 512: interné Shoptet id (keď ho appka pozná, migrácia 0016) — pre
  // priamy odkaz na detail objednávky vo výpise záložky.
  readonly shoptetOrderId: number | null;
}

// Otvorené objednávky (`order.status_name` v nastavenom otvorenom zozname) —
// TÁ ISTÁ definícia "otvorená" ako obrazovka "Na objednanie"
// (`open-statuses.ts`), takže dialóg na výber ukáže presne to, čo appka
// dnes považuje za ešte nevybavené.
async function loadOpenOrders(db: Database): Promise<readonly OpenOrderRow[]> {
  const openStatuses = await listOpenStatusNames(db);
  if (openStatuses.length === 0) return [];
  return db
    .select({
      id: orders.id,
      externalOrderId: orders.externalOrderId,
      customerName: orders.customerName,
      email: orders.email,
      placedAt: orders.placedAt,
      shoptetOrderId: orders.shoptetOrderId,
    })
    .from(orders)
    .where(inArray(orders.statusName, [...openStatuses]));
}

/**
 * Základná objednávka + ostatné OTVORENÉ objednávky TOHO ISTÉHO zákazníka
 * (`customerIdentityKey` vyššie) — presne zoznam, ktorý dialóg na výber
 * zobrazí (zoradené od najnovšej). `null` = základná objednávka sa
 * nenašla/už nie je otvorená.
 */
export async function listMergeableOrders(db: Database, orderId: string): Promise<MergeableOrders | null> {
  const openOrders = await loadOpenOrders(db);
  const base = openOrders.find((o) => o.id === orderId);
  if (base === undefined) return null;
  const baseKey = customerIdentityKey(base.email, base.customerName);
  const candidates = openOrders
    .filter((o) => o.id !== orderId && customerIdentityKey(o.email, o.customerName) === baseKey)
    .sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime())
    .map((o) => ({ orderId: o.id, externalOrderId: o.externalOrderId, placedAt: o.placedAt.toISOString() }));
  return { orderId: base.id, externalOrderId: base.externalOrderId, customerName: base.customerName, email: base.email, candidates };
}

export interface OrderMergeMailContent {
  readonly to: string | null;
  readonly customerName: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly orderNumbers: readonly string[];
}

export type BuildOrderMergeMailResult =
  | { readonly ok: true; readonly content: OrderMergeMailContent }
  | { readonly ok: false; readonly error: "not_found" | "invalid_selection" };

// "č. X" / "č. X a č. Y" / "č. X, č. Y a č. Z" — plynulá veta, nikdy
// odrážkový zoznam (viď registry.ts's komentár k `zoznam_objednavok`).
// Exportovaná — vlastný unit test (`merge-mail.test.ts`) overuje formátovanie
// bez potreby DB.
export function formatOrderNumbers(orderNumbers: readonly string[]): string {
  const withPrefix = orderNumbers.map((n) => `č. ${n}`);
  if (withPrefix.length <= 1) return withPrefix.join("");
  const last = withPrefix[withPrefix.length - 1] ?? "";
  return `${withPrefix.slice(0, -1).join(", ")} a ${last}`;
}

/** Náhľad aj odoslanie počítajú obsah TOU ISTOU cestou — server VŽDY
 * prepočíta zo skutočného aktuálneho stavu DB, nikdy nedôveruje výberu, aký
 * poslal klient (rovnaká disciplína ako `buildSupplierOrderMailContent`). */
export async function buildOrderMergeMailContent(
  db: Database,
  baseOrderId: string,
  otherOrderIds: readonly string[],
): Promise<BuildOrderMergeMailResult> {
  const mergeable = await listMergeableOrders(db, baseOrderId);
  if (mergeable === null) return { ok: false, error: "not_found" };
  const uniqueOtherIds = [...new Set(otherOrderIds)];
  if (uniqueOtherIds.length === 0 || uniqueOtherIds.length !== otherOrderIds.length) {
    return { ok: false, error: "invalid_selection" };
  }
  const candidateByOrderId = new Map(mergeable.candidates.map((c) => [c.orderId, c]));
  for (const id of uniqueOtherIds) {
    if (!candidateByOrderId.has(id)) return { ok: false, error: "invalid_selection" };
  }

  const orderNumbers = [
    mergeable.externalOrderId,
    ...uniqueOtherIds.map((id) => candidateByOrderId.get(id)?.externalOrderId ?? ""),
  ]
    .filter((n) => n !== "")
    .sort((a, b) => a.localeCompare(b, "sk"));

  const template = await resolveTemplate(db, "order_merge");
  const rendered = renderTemplate(template, {
    ...globalContext(),
    meno_zakaznika: textValue(mergeable.customerName),
    zoznam_objednavok: textValue(formatOrderNumbers(orderNumbers)),
  });
  const trimmedEmail = (mergeable.email ?? "").trim();
  return {
    ok: true,
    content: {
      to: trimmedEmail === "" ? null : trimmedEmail,
      customerName: mergeable.customerName,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      orderNumbers,
    },
  };
}

export type SendOrderMergeMailResult =
  | { readonly status: "sent"; readonly to: string; readonly orderNumbers: readonly string[] }
  | { readonly status: "not_found" }
  | { readonly status: "invalid_selection" }
  | { readonly status: "no_email" }
  | { readonly status: "not_configured"; readonly reason: string }
  | { readonly status: "send_failed" };

export interface SendOrderMergeMailOptions {
  readonly db: Database;
  readonly now: Date;
  readonly baseOrderId: string;
  readonly otherOrderIds: readonly string[];
  readonly mailTransport: MailTransport | undefined;
  readonly bccEmail: string | undefined;
  // issue 193: kto tlačidlo stlačil — táto cesta je VŽDY ručná akcia
  // zamestnanca.
  readonly actorUserId?: string;
  // issue 277: rovnaký zámer ako `nedostupne/send.ts`'s `editedBody` — obsluha
  // upravila text priamo v okne náhľadu, predmet ostáva pôvodný.
  readonly editedBody?: string;
}

/**
 * Fail-closed: chýbajúca BCC adresa ALEBO chýbajúci mail transport →
 * NEPOŠLE NIČ (rovnaký zámer ako `nedostupne/send.ts` — majiteľ, "vsade
 * zatial ma byt ked nieco posiela mail"). Žiadny advisory zámok — na rozdiel
 * od `nedostupne` tu neexistuje "už raz odoslané" business pravidlo;
 * jediná pretekárska situácia (dvojklik na TO ISTÉ odoslanie) je už
 * vyriešená jednorazovou spotrebou preview tokenu
 * (`merge-mail-preview-tokens.ts`, vynútené v `http/order-merge-routes.ts`).
 */
export async function sendOrderMergeMail(options: SendOrderMergeMailOptions): Promise<SendOrderMergeMailResult> {
  const { db, now, baseOrderId, otherOrderIds, mailTransport, bccEmail, actorUserId, editedBody } = options;
  const built = await buildOrderMergeMailContent(db, baseOrderId, otherOrderIds);
  if (!built.ok) return { status: built.error };
  // issue 277: obsluha mohla text v okne náhľadu upraviť — odošle sa PRESNE
  // to (predmet ostáva z pôvodného vyrenderovania).
  const finalContent = editedBody === undefined ? built.content : { ...built.content, ...renderEditedBody(editedBody) };

  const logCtx: MailLogContext = {
    source: "order_merge",
    trigger: "manual",
    templateKey: "order_merge",
    orderCode: built.content.orderNumbers.join(","),
    ...(actorUserId === undefined ? {} : { actorUserId }),
  };

  const { to } = built.content;
  if (to === null) {
    await recordSkippedMail(db, now, logCtx, "", "objednávka nemá e-mailovú adresu zákazníka");
    return { status: "no_email" };
  }

  const bccMissing = bccEmail === undefined || bccEmail.trim() === "";
  if (bccMissing) {
    const reason = "chýba adresa pre skrytú kópiu majiteľovi (ORDER_MERGE_BCC_EMAIL)";
    await recordSkippedMail(db, now, logCtx, to, reason);
    return { status: "not_configured", reason };
  }
  if (mailTransport === undefined) {
    const reason = "odosielanie e-mailov nie je nakonfigurované (chýba MAIL_HOST)";
    await recordSkippedMail(db, now, logCtx, to, reason);
    return { status: "not_configured", reason };
  }

  const sendResult = await sendLoggedMail(
    db,
    mailTransport,
    { to, subject: built.content.subject, text: finalContent.text, html: finalContent.html, bcc: bccEmail },
    now,
    logCtx,
  );
  if (!sendResult.ok) {
    log.error(
      { baseOrderId, otherOrderIds, rawErrorMessage: sendResult.rawErrorMessage },
      "Zlúčenie objednávky: odoslanie e-mailu zlyhalo",
    );
    return { status: "send_failed" };
  }
  log.info({ baseOrderId, otherOrderIds }, "Zlúčenie objednávky: e-mail odoslaný");
  return { status: "sent", to, orderNumbers: built.content.orderNumbers };
}
