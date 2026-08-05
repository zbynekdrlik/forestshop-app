import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { upozornenie } from "../../db/schema.js";
import type { UpozornenieSourceValue, UpozornenieTypeValue } from "./queries.js";

// `Pick<Database, ...>` (rovnaký dôvod ako `audit/service.ts`'s
// `AuditExecutor`) — budúci automatický zdroj (#268/#269) môže chcieť volať
// `upsertUpozornenie` VNÚTRI vlastnej transakcie (napr. spolu so zápisom
// stavu sledovania zásielky), takže táto funkcia musí prijať aj `tx`, nie
// len top-level `db`.
export type UpozornenieExecutor = Pick<Database, "insert" | "select" | "update">;

export interface UpsertUpozornenieInput {
  readonly type: UpozornenieTypeValue;
  readonly source: UpozornenieSourceValue;
  readonly title: string;
  readonly details?: string;
  readonly link?: string | null;
  // Dedup kľúč pre automatické zdroje — VLASTNÉ poznámky ho NIKDY nenesú
  // (musí ostať `undefined`/`null`, inak by dva vlastné záznamy s tým istým
  // kľúčom kolidovali na unique indexe, čo pre `source: "vlastne"` nemá
  // zmysel).
  readonly dedupKey?: string | null;
  readonly dueAt?: Date | null;
  readonly createdByUserId?: string | null;
  readonly now: Date;
}

export interface UpozornenieWriteResult {
  readonly id: string;
}

// JEDINÁ zapisovacia cesta pre NOVÉ upozornenie — každý budúci automatický
// zdroj (#268/#269) volá TÚTO funkciu, nikdy vlastný insert (rovnaký princíp
// ako `.claude/rules/mail-log.md`'s "jediná odosielacia cesta"). Keď
// `dedupKey` je zadaný a existuje preň ešte NEVYRIEŠENÝ riadok, ten sa len
// OBNOVÍ (nadpis/podrobnosti/odkaz/termín) — riadok ostáva JEDEN, presne ako
// ticket žiada ("keď nočná úloha zbehne desiatykrát, upozornenie ostane
// JEDNO, len sa obnoví"). `postponedUntil`/`seenAt` sa pri obnove NEDOTÝKAJÚ
// — majiteľovo rozhodnutie odložiť kartu prežije obnovu z toho istého zdroja.
export async function upsertUpozornenie(db: UpozornenieExecutor, input: UpsertUpozornenieInput): Promise<UpozornenieWriteResult> {
  const dedupKey = input.dedupKey ?? null;
  if (dedupKey !== null) {
    const [existing] = await db
      .select({ id: upozornenie.id, resolvedAt: upozornenie.resolvedAt })
      .from(upozornenie)
      .where(eq(upozornenie.dedupKey, dedupKey))
      .limit(1);
    if (existing !== undefined && existing.resolvedAt === null) {
      await db
        .update(upozornenie)
        .set({
          title: input.title,
          details: input.details ?? "",
          link: input.link ?? null,
          dueAt: input.dueAt ?? null,
        })
        .where(eq(upozornenie.id, existing.id));
      return { id: existing.id };
    }
  }
  const [inserted] = await db
    .insert(upozornenie)
    .values({
      type: input.type,
      source: input.source,
      title: input.title,
      details: input.details ?? "",
      link: input.link ?? null,
      dedupKey,
      dueAt: input.dueAt ?? null,
      createdByUserId: input.createdByUserId ?? null,
      createdAt: input.now,
    })
    .returning({ id: upozornenie.id });
  // `.insert().returning()` always yields exactly one row for a single
  // `.values()` object — non-null assertion would be the alternative, but an
  // explicit throw documents the invariant instead of silently trusting it.
  if (inserted === undefined) throw new Error("Vloženie upozornenia zlyhalo bez chyby");
  return { id: inserted.id };
}

export interface CreateOwnNoteInput {
  readonly title: string;
  readonly details?: string;
  readonly dueAt?: Date | null;
  readonly createdByUserId: string;
  readonly now: Date;
}

export async function createOwnNote(db: UpozornenieExecutor, input: CreateOwnNoteInput): Promise<UpozornenieWriteResult> {
  return upsertUpozornenie(db, {
    type: "vlastna_poznamka",
    source: "vlastne",
    title: input.title,
    details: input.details ?? "",
    dueAt: input.dueAt ?? null,
    createdByUserId: input.createdByUserId,
    now: input.now,
  });
}

export interface UpdateOwnNoteInput {
  readonly id: string;
  readonly title: string;
  readonly details?: string;
  readonly dueAt?: Date | null;
}

// Vlastnú poznámku smie upraviť/zmazať len ak `source === "vlastne"` — karta
// zo zdroja "appka" nemá tlačidlá Upraviť/Zmazať vôbec (server to vynucuje
// nezávisle od frontendu, presne rovnaká disciplína ako `requireRole` pri
// iných zápisoch v tejto appke).
export async function updateOwnNote(db: UpozornenieExecutor, input: UpdateOwnNoteInput): Promise<boolean> {
  const result = await db
    .update(upozornenie)
    .set({ title: input.title, details: input.details ?? "", dueAt: input.dueAt ?? null })
    .where(and(eq(upozornenie.id, input.id), eq(upozornenie.source, "vlastne")))
    .returning({ id: upozornenie.id });
  return result.length > 0;
}

export async function deleteOwnNote(db: Database, id: string): Promise<boolean> {
  const result = await db
    .delete(upozornenie)
    .where(and(eq(upozornenie.id, id), eq(upozornenie.source, "vlastne")))
    .returning({ id: upozornenie.id });
  return result.length > 0;
}

export interface ResolveInput {
  readonly id: string;
  readonly resolvedByUserId: string;
  readonly now: Date;
}

// Vyriešenie si "vidí" kartu zároveň (`seenAt`, ak ešte nebola) — obsluha,
// ktorá klikla "Vybavené", kartu tým pádom videla, aj keby predtým bola ešte
// "Nové" (COALESCE zachová PÔVODNÝ čas videnia, ak už existoval).
export async function resolveUpozornenie(db: Database, input: ResolveInput): Promise<boolean> {
  const [row] = await db.select({ seenAt: upozornenie.seenAt }).from(upozornenie).where(eq(upozornenie.id, input.id)).limit(1);
  if (row === undefined) return false;
  const result = await db
    .update(upozornenie)
    .set({ resolvedAt: input.now, resolvedByUserId: input.resolvedByUserId, seenAt: row.seenAt ?? input.now })
    .where(eq(upozornenie.id, input.id))
    .returning({ id: upozornenie.id });
  return result.length > 0;
}

export interface PostponeInput {
  readonly id: string;
  readonly postponedUntil: Date;
  readonly now: Date;
}

export async function postponeUpozornenie(db: Database, input: PostponeInput): Promise<boolean> {
  const [row] = await db.select({ seenAt: upozornenie.seenAt }).from(upozornenie).where(eq(upozornenie.id, input.id)).limit(1);
  if (row === undefined) return false;
  const result = await db
    .update(upozornenie)
    .set({ postponedUntil: input.postponedUntil, seenAt: row.seenAt ?? input.now })
    .where(eq(upozornenie.id, input.id))
    .returning({ id: upozornenie.id });
  return result.length > 0;
}

export interface CancelPostponeInput {
  readonly id: string;
}

// issue 267 (živé overenie, gap 2): jediný spôsob, ako "vrátiť" odloženú
// kartu SKÔR, než sa vráti sama (napr. majiteľ sa pomýlil v dátume) — na
// rozdiel od `postponeUpozornenie` sa `seenAt` NEDOTÝKA (karta bola už
// videná v momente odloženia, viď `postponeUpozornenie` vyššie).
export async function cancelPostpone(db: Database, input: CancelPostponeInput): Promise<boolean> {
  const result = await db.update(upozornenie).set({ postponedUntil: null }).where(eq(upozornenie.id, input.id)).returning({ id: upozornenie.id });
  return result.length > 0;
}

// Volané pri OTVORENÍ záložky — hromadne označí VŠETKY práve "Nové" karty
// ako videné naraz (inbox vzor "otvoriť = prečítané"), žiadne per-kartové
// tlačidlo "videné" navyše. Zámerne LEN `seenAt IS NULL` (nikdy nerieši
// odložené/vyriešené karty — tie svoj `seenAt` už majú z okamihu prvej akcie
// nad nimi, viď `resolveUpozornenie`/`postponeUpozornenie` vyššie).
export async function markAllSeen(db: Database, now: Date): Promise<number> {
  const result = await db.update(upozornenie).set({ seenAt: now }).where(isNull(upozornenie.seenAt)).returning({ id: upozornenie.id });
  return result.length;
}
