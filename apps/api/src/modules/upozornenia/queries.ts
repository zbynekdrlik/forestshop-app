import { and, asc, count, desc, eq, isNotNull, isNull, lte, or, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { upozornenie, users, type upozornenieType } from "../../db/schema.js";
import { computeStatus, type UpozornenieStatus } from "./status.js";

export type UpozornenieTypeValue = (typeof upozornenieType.enumValues)[number];
export type UpozornenieSourceValue = "vlastne" | "appka";

export interface UpozornenieRow {
  readonly id: string;
  readonly type: UpozornenieTypeValue;
  readonly source: UpozornenieSourceValue;
  readonly title: string;
  readonly details: string;
  readonly link: string | null;
  readonly dueAt: Date | null;
  readonly postponedUntil: Date | null;
  readonly seenAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly status: UpozornenieStatus;
}

export interface UpozornenieFilter {
  readonly type?: UpozornenieTypeValue;
  readonly includeResolved: boolean;
  // issue 267 (živé overenie, gap 2): NEZÁVISLÁ os od `includeResolved` —
  // karta môže byť odložená bez toho, aby bola vybavená. Bez tohto
  // parametra neexistovala ŽIADNA hodnota `includeResolved`, ktorá by
  // odloženú kartu odkryla (`notPostponedCondition` sa aplikovala VŽDY).
  readonly includePostponed?: boolean;
}

// Odložené karty ZOSTÁVAJÚ skryté, kým sa nevrátia SAMÉ (ticket: "zmizne zo
// zoznamu a v ten deň sa vráti späť") — s JEDINOU výnimkou:
// `filter.includePostponed === true` (issue 267 follow-up, gap 2: živé
// overenie zistilo, že bez tejto výnimky sa odložená karta nedala pozrieť
// ANI opraviť, keby sa majiteľ pomýlil v dátume). Zdieľané so
// `countActionableUpozornenia` nižšie (code review na PR pred mergom: dve
// nezávislé implementácie tej istej podmienky driftujú) — JEDNA funkcia
// rozhoduje "nie je práve odložené" pre OBOCH volajúcich; odznak v menu
// (nižšie) túto výnimku NIKDY nedostáva — je to len UI zobrazenie na
// požiadanie, nie zmena toho, čo je "akčné".
function notPostponedCondition(now: Date): SQL {
  return or(isNull(upozornenie.postponedUntil), lte(upozornenie.postponedUntil, now)) as SQL;
}

// Filter beží PRIAMO v SQL (nie JS `.filter()` po natiahnutí všetkého) —
// `type` má dnes jedinú možnú hodnotu, takže porovnanie v JS by eslintu
// vyzeralo ako vždy-pravdivé (`@typescript-eslint/no-unnecessary-condition`);
// SQL porovnanie tento problém nemá a je to aj správne miesto na filter.
// Zoradenie: najbližší termín ("vybaviť do") prvý, karty bez termínu
// naposledy, v rámci toho najnovšie vytvorené prvé.
export async function listUpozornenia(db: Database, filter: UpozornenieFilter, now: Date): Promise<readonly UpozornenieRow[]> {
  const conditions = [
    ...(filter.includePostponed === true ? [] : [notPostponedCondition(now)]),
    ...(filter.type === undefined ? [] : [eq(upozornenie.type, filter.type)]),
    ...(filter.includeResolved ? [] : [isNull(upozornenie.resolvedAt)]),
  ];

  const rows = await db
    .select()
    .from(upozornenie)
    .where(and(...conditions))
    .orderBy(asc(upozornenie.dueAt), desc(upozornenie.createdAt));

  return rows.map((r) => ({ ...r, status: computeStatus(r, now) }));
}

// Odznak v ľavom menu — rovnaký predikát, aký rozhoduje predvolený filter
// "len nevybavené" (návrhový komentár na tickete: číslo v menu MUSÍ
// zodpovedať tomu, čo appka ukáže pri otvorení záložky). Code review pred
// mergom: pôvodná verzia natiahla VŠETKY riadky do JS a filtrovala cez
// `isActionableNow` — funkčne zhodné, ale druhá, nezávisle udržiavaná
// implementácia TEJ ISTEJ podmienky (driftové riziko) a zbytočný celý-
// tabuľkový sken. `COUNT(*) WHERE resolved_at IS NULL AND <notPostponed>`
// zdieľa `notPostponedCondition` s `listUpozornenia` vyššie.
export async function countActionableUpozornenia(db: Database, now: Date): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(upozornenie)
    .where(and(isNull(upozornenie.resolvedAt), notPostponedCondition(now)));
  return row?.total ?? 0;
}

// issue 283: majiteľ rozhodol na tickete — záložka "Vybavené" na nástenke,
// história vybavených kariet zoradená OD NAJNOVŠIE VYBAVENÝCH, s menom+časom
// toho, kto vybavil. Rovnaký cap-namiesto-stránkovania vzor ako `mail-log/
// queries.ts`'s pevný `limit: 200` — appka nikde inde nemá stránkovaciu UI, a
// tabuľka rastie monotónne (vybavené vrátkové karty sa nikdy nemažú, viď
// `.claude/rules/upozornenia.md`), takže cap je nutný.
export const RESOLVED_LIST_LIMIT = 200;

export interface ResolvedUpozornenieRow extends UpozornenieRow {
  // `null` = vybavené AUTOMATICKY systémom (#268's `autoResolveByDedupKey`
  // nikdy nevypĺňa `resolvedByUserId` — schéma to explicitne predpovedá,
  // `schema-upozornenia.ts`). Frontend zobrazí zástupný text "automaticky".
  // Code review: `resolvedByUserId` má `onDelete: "set null"` — ak sa neskôr
  // zmaže účet zamestnanca, čo predtým RUČNE vybavil kartu, `resolvedByName`
  // sa stane `null` a tá karta sa zobrazí nerozoznateľne od naozaj
  // automaticky vybavenej. Prijaté zámerne (predpríprava opačnej výnimky by
  // vyžadovala nový stĺpec/audit záznam mimo rozsahu tohto ticketu) — ak sa
  // niekedy ukáže ako problém, riešenie je čítať `audit_events` (`entity:
  // "upozornenie"`, `action: "upozornenie.resolved"`) namiesto tejto FK.
  readonly resolvedByName: string | null;
}

export async function listResolvedUpozornenia(db: Database, now: Date): Promise<readonly ResolvedUpozornenieRow[]> {
  const rows = await db
    .select({
      id: upozornenie.id,
      type: upozornenie.type,
      source: upozornenie.source,
      title: upozornenie.title,
      details: upozornenie.details,
      link: upozornenie.link,
      dueAt: upozornenie.dueAt,
      postponedUntil: upozornenie.postponedUntil,
      seenAt: upozornenie.seenAt,
      resolvedAt: upozornenie.resolvedAt,
      createdAt: upozornenie.createdAt,
      resolvedByName: users.displayName,
    })
    .from(upozornenie)
    .leftJoin(users, eq(upozornenie.resolvedByUserId, users.id))
    .where(isNotNull(upozornenie.resolvedAt))
    .orderBy(desc(upozornenie.resolvedAt))
    .limit(RESOLVED_LIST_LIMIT);

  return rows.map((r) => ({ ...r, status: computeStatus(r, now) }));
}
