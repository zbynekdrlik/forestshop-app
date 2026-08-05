import { and, asc, count, desc, eq, isNull, lte, or, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { upozornenie, type upozornenieType } from "../../db/schema.js";
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
}

// Odložené karty ZOSTÁVAJÚ skryté, kým sa nevrátia — bez ohľadu na filter
// "aj vybavené" (ticket: "zmizne zo zoznamu a v ten deň sa vráti späť", žiadny
// spôsob si ich pozrieť skôr). Zdieľané so `countActionableUpozornenia`
// nižšie (code review na PR pred mergom: dve nezávislé implementácie tej
// istej podmienky driftujú) — JEDNA funkcia rozhoduje "nie je práve
// odložené" pre OBOCH volajúcich.
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
    notPostponedCondition(now),
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
