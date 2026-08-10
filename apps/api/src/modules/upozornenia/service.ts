import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
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
//
// issue 272: JEDEN atomický SQL príkaz (`INSERT ... ON CONFLICT (dedup_key)
// WHERE resolved_at IS NULL DO UPDATE ...`), nie samostatný SELECT + podľa
// jeho výsledku podmienený UPDATE/INSERT — ten mal TOCTOU medzeru (dve
// súbežné volania s tým istým, dosiaľ nepoužitým `dedupKey` mohli OBE vidieť
// "žiadny riadok" a obe skončiť INSERT-om, druhé s vyhodenou chybou namiesto
// obnovy). `targetWhere` zrkadlí PRESNE predikát `upozornenie_dedup_key_uq`
// (`schema-upozornenia.ts`) — Postgres tak vie rozpoznať konflikt len s
// NEVYRIEŠENÝM riadkom, presne ako predtým robil samostatný SELECT. Keď
// `dedupKey` je `null` (vlastné poznámky), unique index sa naň NIKDY
// nevzťahuje (Postgres nikdy nepovažuje dve NULL hodnoty za rovnaké), takže
// ON CONFLICT sa preň jednoducho nikdy neuplatní — vlastné poznámky ostávajú
// vždy nový riadok, presne ako predtým.
export async function upsertUpozornenie(db: UpozornenieExecutor, input: UpsertUpozornenieInput): Promise<UpozornenieWriteResult> {
  const dedupKey = input.dedupKey ?? null;
  const [row] = await db
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
    .onConflictDoUpdate({
      target: upozornenie.dedupKey,
      targetWhere: sql`resolved_at IS NULL`,
      set: {
        title: input.title,
        details: input.details ?? "",
        link: input.link ?? null,
        dueAt: input.dueAt ?? null,
      },
    })
    .returning({ id: upozornenie.id });
  // `.insert().returning()` always yields exactly one row (either the newly
  // inserted row, or the conflicting row after the atomic update) — non-null
  // assertion would be the alternative, but an explicit throw documents the
  // invariant instead of silently trusting it.
  if (row === undefined) throw new Error("Vloženie/aktualizácia upozornenia zlyhala bez chyby");
  return { id: row.id };
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

// issue 267 pôvodne obmedzilo mazanie len na `source === "vlastne"`
// (`deleteOwnNote`) — issue 327 (majiteľ, zákres "Odstrániť" vedľa
// "Odložiť" v akčnom riadku, ktorý sa renderuje pre VŠETKY nevyriešené
// karty, plus generický text ticketu "upozornenie odstrániť") rozšírilo
// mazanie na VŠETKY zdroje. Na rozdiel od "Upraviť" (editácia
// titulku/textu, `updateOwnNote` nižšie — ostáva vlastníctvom LEN vlastných
// poznámok, editovať generovaný text automatickej karty nedáva zmysel),
// zmazanie CELÉHO riadku je zmysluplné pre AKÝKOĽVEK zdroj — majiteľ chce
// vedieť trvalo odstrániť aj automaticky vygenerovanú kartu, ktorú už
// nechce vidieť. Znova-ohlásiteľné typy (napr. `objednavka_visi`,
// `.claude/rules/upozornenia.md`) sa jednoducho znova vytvoria pri ďalšom
// behu, ak podmienka stále platí — rovnaké správanie ako keby karta nikdy
// nevznikla.
export async function deleteUpozornenie(db: Database, id: string): Promise<boolean> {
  const result = await db.delete(upozornenie).where(eq(upozornenie.id, id)).returning({ id: upozornenie.id });
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

// issue 268: automatický zdroj (napr. `posta-uncollected/run.ts`) volá TOTO
// namiesto `resolveUpozornenie`, keď zásielka prestane byť problémom SAMA od
// seba (doručená/vrátená) — na rozdiel od ručného vyriešenia
// `resolvedByUserId` ostáva `null` (schéma to explicitne predpovedá: "null
// pri vyplnenom resolvedAt znamená vybavené systémom"). Bezpečný no-op, keď
// pre daný `dedupKey` žiadny NEVYRIEŠENÝ riadok neexistuje (karta ešte
// nevznikla, alebo bola vyriešená/nahradená novou vlnou už skôr).
export async function autoResolveByDedupKey(db: UpozornenieExecutor, dedupKey: string, now: Date): Promise<boolean> {
  const result = await db
    .update(upozornenie)
    .set({ resolvedAt: now })
    .where(and(eq(upozornenie.dedupKey, dedupKey), isNull(upozornenie.resolvedAt)))
    .returning({ id: upozornenie.id });
  return result.length > 0;
}

export interface UpdateIfUnresolvedInput {
  readonly title: string;
  readonly details: string;
}

// issue 275: keď automatický zdroj zistí, že jeho vlastné sledovanie (napr.
// tracking na Pošte SK) prestalo fungovať, a pre `dedupKey` UŽ existuje
// nevyriešená karta (vznikla skôr, kým sledovanie ešte fungovalo) — táto
// karta sa má OZNAČIŤ inak (aby majiteľ vedel, PREČO sa sama nezavrie), ale
// NIKDY automaticky zavrieť (to by skrylo reálny, ešte nevyriešený problém)
// ani NIKDY vytvoriť ako novú (zdroj, čo nikdy predtým problém nehlásil,
// nepotrebuje novú kartu len kvôli jednorazovému/prechodnému zlyhaniu
// sledovania). Na rozdiel od `upsertUpozornenie` preto NIKDY nevkladá nový
// riadok — čisto UPDATE-if-exists. Bezpečný no-op, keď pre `dedupKey` žiadna
// nevyriešená karta neexistuje.
export async function updateIfUnresolvedByDedupKey(db: UpozornenieExecutor, dedupKey: string, input: UpdateIfUnresolvedInput): Promise<boolean> {
  const result = await db
    .update(upozornenie)
    .set({ title: input.title, details: input.details })
    .where(and(eq(upozornenie.dedupKey, dedupKey), isNull(upozornenie.resolvedAt)))
    .returning({ id: upozornenie.id });
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

// SQLSTATE 23505 = unique_violation. Rovnaký vzor ako `catalog/ingest.ts`'s
// `isUniqueViolation` (tam neexportovaná, jediný dovtedy konzument) —
// duplikovaná tu zámerne malá (10 riadkov), namiesto zdieľanej abstrakcie pre
// dvoch konzumentov, ktorí navyše žijú v úplne nesúvisiacich moduloch
// (`.claude/rules/mvp-philosophy.md`'s "žiadna abstrakcia pre jediného/pár
// konzumentov, ak je priama implementácia rovnako čitateľná").
function isUniqueViolation(error: unknown, constraint: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505" && "constraint" in error && error.constraint === constraint;
}

export type ReturnToOpenResult = "returned" | "no_op" | "collision";

export interface ReturnToOpenInput {
  readonly id: string;
}

// issue 283 (majiteľ, komentár na tickete): "Vybavené" záložka umožňuje
// vrátiť omylom vybavenú kartu späť medzi otvorené. `upozornenie_dedup_key_uq`
// je ČIASTOČNÝ unique index (`WHERE resolved_at IS NULL`,
// `schema-upozornenia.ts`) — vyčistenie `resolvedAt` môže preto naraziť na
// UŽ EXISTUJÚCU otvorenú kartu s rovnakým `dedupKey` (automatický zdroj,
// napr. #269's vrátenie, ktoré je zámerne znovu-ohlásiteľné). Kolízia sa
// ODCHYTÁVA z DB chyby jediného atomického UPDATE-u (rovnaký princíp ako
// `upsertUpozornenie`'s `ON CONFLICT`), NIE cez samostatný SELECT-pred-UPDATE
// pre-check — ten by znovu otvoril presne tú TOCTOU triedu chyby, akú tento
// modul už dvakrát riešil na tom istom čiastočnom indexe (#272/#269,
// `.claude/rules/upozornenia.md`). WHERE `resolved_at IS NOT NULL` zaručuje,
// že karta, ktorá už NIE JE vybavená (dvojklik/medzičasom vrátená inak), sa
// tíško no-opne — rovnaká disciplína ako `resolveUpozornenie`/`cancelPostpone`
// vyššie (neznáme/nevhodné id nikdy nevyhodí, vždy 200).
export async function returnUpozornenieToOpen(db: Database, input: ReturnToOpenInput): Promise<ReturnToOpenResult> {
  try {
    const result = await db
      .update(upozornenie)
      .set({ resolvedAt: null, resolvedByUserId: null })
      .where(and(eq(upozornenie.id, input.id), isNotNull(upozornenie.resolvedAt)))
      .returning({ id: upozornenie.id });
    return result.length > 0 ? "returned" : "no_op";
  } catch (error) {
    if (isUniqueViolation(error, "upozornenie_dedup_key_uq")) return "collision";
    throw error;
  }
}
