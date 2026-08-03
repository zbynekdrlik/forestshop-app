import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { mailTemplateHistory, mailTemplates, users } from "../../db/schema.js";
import { allowedPlaceholderNames, MAIL_TEMPLATE_KEYS, MAIL_TEMPLATE_KINDS, type MailTemplateKey } from "./registry.js";
import { validateTemplateText, type MailTemplateText } from "./render.js";

// issue 192: čítanie a zápis upravených znení. Nikde tu nie je HTTP ani
// e-mail — odosielacie cesty si len vypýtajú výsledné znenie
// (`resolveTemplate`) a ďalej pracujú s čistou renderovacou funkciou.

export interface ResolvedTemplate extends MailTemplateText {
  readonly key: MailTemplateKey;
  /** `false` = platí pôvodné znenie z kódu (v databáze nie je žiadny riadok). */
  readonly isCustomized: boolean;
  readonly updatedAt: Date | null;
  readonly updatedByName: string | null;
}

/** Výsledné znenie pre daný druh e-mailu — upravené, ak existuje, inak
 * pôvodné z kódu. Toto je JEDINÝ vstup odosielacích ciest; nikdy nečítaj
 * `mailTemplates` priamo, inak by ti chýbal fallback na pôvodné znenie. */
export async function resolveTemplate(db: Database, key: MailTemplateKey): Promise<MailTemplateText> {
  const [row] = await db.select({ subject: mailTemplates.subject, body: mailTemplates.body }).from(mailTemplates).where(eq(mailTemplates.key, key)).limit(1);
  return row ?? MAIL_TEMPLATE_KINDS[key].defaultText;
}

export async function listTemplates(db: Database): Promise<readonly ResolvedTemplate[]> {
  const rows = await db
    .select({
      key: mailTemplates.key,
      subject: mailTemplates.subject,
      body: mailTemplates.body,
      updatedAt: mailTemplates.updatedAt,
      updatedByName: users.displayName,
    })
    .from(mailTemplates)
    .leftJoin(users, eq(users.id, mailTemplates.updatedByUserId));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return MAIL_TEMPLATE_KEYS.map((key) => {
    const row = byKey.get(key);
    if (row === undefined) {
      const { subject, body } = MAIL_TEMPLATE_KINDS[key].defaultText;
      return { key, subject, body, isCustomized: false, updatedAt: null, updatedByName: null };
    }
    return {
      key,
      subject: row.subject,
      body: row.body,
      isCustomized: true,
      updatedAt: row.updatedAt,
      updatedByName: row.updatedByName,
    };
  });
}

export type SaveTemplateResult = { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] };

/** Uloží upravené znenie. Kontrola beží PRED zápisom — neplatná šablóna sa
 * neuloží vôbec, takže preklep v názve poľa sa nikdy nemôže dostať k
 * zákazníkovi ako surový text. */
export async function saveTemplate(
  db: Database,
  input: { readonly key: MailTemplateKey; readonly subject: string; readonly body: string; readonly userId: string; readonly now: Date },
): Promise<SaveTemplateResult> {
  const text: MailTemplateText = { subject: input.subject.trim(), body: input.body.trim() };
  const errors = validateTemplateText(text, allowedPlaceholderNames(input.key));
  if (errors.length > 0) return { ok: false, errors };

  await db.transaction(async (tx) => {
    await tx
      .insert(mailTemplates)
      .values({ key: input.key, subject: text.subject, body: text.body, updatedAt: input.now, updatedByUserId: input.userId })
      .onConflictDoUpdate({
        target: mailTemplates.key,
        set: { subject: text.subject, body: text.body, updatedAt: input.now, updatedByUserId: input.userId },
      });
    await tx.insert(mailTemplateHistory).values({
      key: input.key,
      action: "save",
      subject: text.subject,
      body: text.body,
      changedAt: input.now,
      changedByUserId: input.userId,
    });
  });
  return { ok: true };
}

/** Vráti pôvodné znenie = zmaže riadok. Do histórie sa zapíše, aké znenie
 * odvtedy platí (to pôvodné z kódu), aby sa dala čítať bez znalosti verzie
 * kódu. */
export async function resetTemplate(
  db: Database,
  input: { readonly key: MailTemplateKey; readonly userId: string; readonly now: Date },
): Promise<void> {
  const original = MAIL_TEMPLATE_KINDS[input.key].defaultText;
  await db.transaction(async (tx) => {
    await tx.delete(mailTemplates).where(eq(mailTemplates.key, input.key));
    await tx.insert(mailTemplateHistory).values({
      key: input.key,
      action: "reset",
      subject: original.subject,
      body: original.body,
      changedAt: input.now,
      changedByUserId: input.userId,
    });
  });
}

export interface TemplateHistoryEntry {
  readonly id: string;
  readonly action: "save" | "reset";
  readonly subject: string;
  readonly body: string;
  readonly changedAt: Date;
  readonly changedByName: string | null;
}

export async function listTemplateHistory(db: Database, key: MailTemplateKey, limit = 20): Promise<readonly TemplateHistoryEntry[]> {
  return db
    .select({
      id: mailTemplateHistory.id,
      action: mailTemplateHistory.action,
      subject: mailTemplateHistory.subject,
      body: mailTemplateHistory.body,
      changedAt: mailTemplateHistory.changedAt,
      changedByName: users.displayName,
    })
    .from(mailTemplateHistory)
    .leftJoin(users, eq(users.id, mailTemplateHistory.changedByUserId))
    .where(and(eq(mailTemplateHistory.key, key)))
    .orderBy(desc(mailTemplateHistory.changedAt))
    .limit(limit);
}
