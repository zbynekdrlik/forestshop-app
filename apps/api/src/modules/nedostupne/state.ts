import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { nedostupneState } from "../../db/schema.js";
import type { NedostupneEmailType } from "./constants.js";

/** `true` keď presne TENTO (objednávka, variant, typ) e-mail už bol odoslaný
 * — dedup kľúč, rovnaký zámer ako stará appka's `sent_map['<orderCode>|<type>']`
 * (`nedostupne.py`'s `plan_sends`), len rozšírený o `variant_code` (nová
 * appka flaguje PER RIADOK objednávky, nie per produkt globálne). */
export async function hasSentNedostupne(
  db: Pick<Database, "select">,
  orderCode: string,
  variantCode: string,
  emailType: NedostupneEmailType,
): Promise<boolean> {
  const rows = await db
    .select({ id: nedostupneState.id })
    .from(nedostupneState)
    .where(and(eq(nedostupneState.orderCode, orderCode), eq(nedostupneState.variantCode, variantCode), eq(nedostupneState.emailType, emailType)))
    .limit(1);
  return rows.length > 0;
}

/** Zoznam VŠETKÝCH odoslaných záznamov — `queries.ts`'s zoznam ich potrebuje
 * naraz (jeden dopyt namiesto N `hasSentNedostupne` volaní na riadok). */
export async function loadSentNedostupne(db: Pick<Database, "select">): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ orderCode: nedostupneState.orderCode, variantCode: nedostupneState.variantCode, emailType: nedostupneState.emailType })
    .from(nedostupneState);
  return new Set(rows.map((r) => sentKey(r.orderCode, r.variantCode, r.emailType)));
}

export function sentKey(orderCode: string, variantCode: string, emailType: string): string {
  return `${orderCode}|${variantCode}|${emailType}`;
}

/** Zapíše dedup dôkaz IHNEĎ po úspešnom odoslaní (rovnaká disciplína ako
 * #172/#173 — pád appky neskôr v behu nesmie stratiť dôkaz o už odoslanom
 * e-maile). Nikdy sa neprepisuje/nemaže. */
export async function markSentNedostupne(
  db: Pick<Database, "insert">,
  orderCode: string,
  variantCode: string,
  emailType: NedostupneEmailType,
  now: Date,
): Promise<void> {
  await db.insert(nedostupneState).values({ orderCode, variantCode, emailType, sentAt: now });
}
