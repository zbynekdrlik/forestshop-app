import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { mailLog, users } from "../../db/schema.js";
import { buildShoptetAdminOrderUrl } from "../orders/queries.js";
import { orders } from "../../db/schema.js";
import type { MailLogSource } from "./service.js";

export interface MailLogFilter {
  readonly source?: MailLogSource;
  readonly status?: "sent" | "failed" | "skipped";
  readonly since?: Date;
  readonly limit: number;
}

export interface MailLogRow {
  readonly id: string;
  readonly createdAt: string;
  readonly source: MailLogSource;
  readonly status: "sent" | "failed" | "skipped";
  readonly trigger: "scheduled" | "manual";
  readonly templateKey: string | null;
  readonly recipient: string;
  readonly subject: string | null;
  readonly orderCode: string | null;
  readonly variantCode: string | null;
  readonly packageNumber: string | null;
  readonly sequence: number | null;
  readonly reason: string | null;
  readonly actorName: string | null;
  readonly adminLink: string | null;
}

export interface MailLogSummary {
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
  /** Koľkokrát dedup zabránil druhému e-mailu tomu istému zákazníkovi —
   * ticketova podmienka "ochrana pred dvojitým odoslaním musí byť z prehľadu
   * viditeľná" (`DUPLICATE_REASON`, `service.ts` volajúci ju vkladajú). */
  readonly duplicatesBlocked: number;
}

/** Dôvod, ktorý sa počíta ako "zabránená duplicita" — jeden reťazec zdieľaný
 * medzi zapisujúcimi miestami a týmto súhrnom, nikdy dva samostatné literály
 * (rozišli by sa a súhrn by ticho ukazoval nulu). */
export const DUPLICATE_REASON = "už bolo odoslané skôr — druhý e-mail sa neposiela";

function whereFor(filter: MailLogFilter) {
  const parts = [];
  if (filter.source !== undefined) parts.push(eq(mailLog.source, filter.source));
  if (filter.status !== undefined) parts.push(eq(mailLog.status, filter.status));
  if (filter.since !== undefined) parts.push(gte(mailLog.createdAt, filter.since));
  return parts.length === 0 ? undefined : and(...parts);
}

export async function listMailLog(db: Database, filter: MailLogFilter, adminBaseUrl: string): Promise<readonly MailLogRow[]> {
  const rows = await db
    .select({
      id: mailLog.id,
      createdAt: mailLog.createdAt,
      source: mailLog.source,
      status: mailLog.status,
      trigger: mailLog.trigger,
      templateKey: mailLog.templateKey,
      recipient: mailLog.recipient,
      subject: mailLog.subject,
      orderCode: mailLog.orderCode,
      variantCode: mailLog.variantCode,
      packageNumber: mailLog.packageNumber,
      sequence: mailLog.sequence,
      reason: mailLog.reason,
      actorName: users.displayName,
      shoptetOrderId: orders.shoptetOrderId,
    })
    .from(mailLog)
    .leftJoin(users, eq(mailLog.actorUserId, users.id))
    // Objednávka sa dohľadáva LEN kvôli odkazu do Shoptetu — `leftJoin`, aby
    // zmazaná/nikdy neimportovaná objednávka nikdy nezahodila riadok knihy.
    .leftJoin(orders, eq(mailLog.orderCode, orders.externalOrderId))
    .where(whereFor(filter))
    .orderBy(desc(mailLog.createdAt))
    .limit(filter.limit);

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    source: r.source,
    status: r.status,
    trigger: r.trigger,
    templateKey: r.templateKey,
    recipient: r.recipient,
    subject: r.subject,
    orderCode: r.orderCode,
    variantCode: r.variantCode,
    packageNumber: r.packageNumber,
    sequence: r.sequence,
    reason: r.reason,
    actorName: r.actorName,
    adminLink: r.orderCode === null ? null : buildShoptetAdminOrderUrl(adminBaseUrl, r.orderCode, r.shoptetOrderId),
  }));
}

export async function summarizeMailLog(db: Database, filter: MailLogFilter): Promise<MailLogSummary> {
  const summaryFilter: MailLogFilter = {
    limit: filter.limit,
    ...(filter.source === undefined ? {} : { source: filter.source }),
    ...(filter.since === undefined ? {} : { since: filter.since }),
  };
  const rows = await db
    .select({
      status: mailLog.status,
      total: count(),
      duplicates: sql<number>`count(*) filter (where ${mailLog.reason} = ${DUPLICATE_REASON})::int`,
    })
    .from(mailLog)
    // Súhrn zámerne bez filtra stavu — inak by pri zapnutom "len odoslané"
    // tvrdil, že nič nezlyhalo. `status` sa preto z filtra vypúšťa celkom
    // (nie nastaví na `undefined` — `exactOptionalPropertyTypes`).
    .where(whereFor(summaryFilter))
    .groupBy(mailLog.status);

  const pick = (status: "sent" | "failed" | "skipped"): number => rows.find((r) => r.status === status)?.total ?? 0;
  return {
    sent: pick("sent"),
    failed: pick("failed"),
    skipped: pick("skipped"),
    duplicatesBlocked: rows.reduce((sum, r) => sum + r.duplicates, 0),
  };
}
