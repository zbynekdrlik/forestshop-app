// Brána prijatia snapshotu. Čistá funkcia bez I/O — presne preto sa dá otestovať
// jedným prípadom na každé historické zlyhanie (#277, #281, #286).

/**
 * Stĺpce, bez ktorých sa export nedá spracovať. Zoznam je zámerne krátky: pokrýva
 * identitu, cenu s menou, sklad a dostupnosť. Chýbajúci `supplier` bol príčinou
 * #281 — plnohodnotný export bez tohto stĺpca prešiel, lebo sa stĺpce nekontrolovali.
 */
// `readonly` is compile-time only — Object.freeze stops any runtime consumer
// from mutating this shared array and changing the gate's behaviour process-wide.
export const REQUIRED_COLUMNS: readonly string[] = Object.freeze([
  "code",
  // Identita produktu (review task-5-fix-1, CRITICAL #1) — bez neho sa export
  // nedá spracovať vôbec, rovnako ako bez `supplier` (#281).
  "guid",
  "pairCode",
  "name",
  "supplier",
  "price",
  "standardPrice",
  "purchasePrice",
  "currency",
  "includingVat",
  "percentVat",
  "actionPrice",
  "actionFrom",
  "actionUntil",
  "stock",
  "availabilityInStock",
  "availabilityOutOfStock",
  "productVisibility",
  "variantVisibility",
]);

export interface SnapshotLimits {
  readonly minByteSize: number;
  readonly absoluteMinRows: number;
  readonly previousRowRatio: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = Object.freeze({
  // Reálny export má ~56 MB; 1 MB je hranica „toto zjavne nie je celý katalóg".
  minByteSize: 1_000_000,
  // Podlaha NA KAŽDOM importe, nielen prvom — je spodná hranica pre
  // `Math.max(pomerová hranica, absoluteMinRows)` nižšie. Samotná pomerová
  // hranica by sa dala ratchetnúť k nule cez opakované, mierne klesajúce
  // prijaté exporty (#286): floor(1 * 0.8) === 0.
  absoluteMinRows: 1_000,
  previousRowRatio: 0.8,
});

export interface SnapshotCandidate {
  readonly columns: readonly string[];
  readonly rowCount: number;
  readonly byteSize: number;
  // Riadky, kde počet polí po rozparsovaní nesedí s počtom stĺpcov v hlavičke —
  // typicky jedna nezacitovaná úvodzovka v popise, ktorá rozdelí jeden riadok na
  // dva plné prázdnych polí. Počet riadkov len stúpne o jeden a ľahko prejde
  // pomerovou hranicou, takže poškodenie treba odmietnuť samostatne.
  readonly malformedRowCount: number;
  // Počet riadkov, ktoré sa rozparsovali AJ vyrobili použiteľný záznam (review
  // task-5-fix-1, dôležité #3). Predtým brána dostávala len `rowCount`
  // (rozparsované riadky) — export, ktorého `code` je prázdny na KAŽDOM riadku,
  // tak prešiel hlavičkovou aj pomerovou kontrolou (rowCount sa nezmenil), bol
  // prijatý, a blanketový „označ všetko mimo tohto snapshotu ako chýbajúce"
  // update potom označil CELÝ katalóg ako chýbajúci — #277/#286 v novej podobe.
  readonly usableRecordCount: number;
  // Prečo daný riadok NEVYROBIL použiteľný záznam — kľúč je ľudsky čitateľný
  // (slovenský) popis príčiny (napr. "prázdny kód"), hodnota jej počet medzi
  // nepoužiteľnými riadkami tohto exportu. Voliteľné (chýba, keď volajúci túto
  // rozpisku nemá) — používa sa LEN na obohatenie dôvodu odmietnutia nižšie,
  // nikdy na samotné rozhodnutie o verdikte.
  readonly unusableReasonCounts?: Readonly<Record<string, number>>;
  readonly previousAccepted: { readonly rowCount: number } | null;
}

export type SnapshotJudgement =
  | { readonly verdict: "accepted" }
  | { readonly verdict: "rejected"; readonly reason: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Every comparison against `NaN` is `false`, so a caller passing `NaN` (or any
 * other non-finite/non-array shape) would fall through every guard below and
 * be silently ACCEPTED instead of rejected — the exact failure mode this checks
 * against. `columns` failing `Array.isArray` also covers a `string`, which would
 * otherwise satisfy every `Array.prototype.includes` check by substring match,
 * and a `null` `columns`, which would otherwise throw a `TypeError` out of a
 * function whose whole contract is to return a verdict, never throw.
 */
function candidateIsValid(candidate: SnapshotCandidate): boolean {
  if (!Array.isArray(candidate.columns)) return false;
  if (!isFiniteNumber(candidate.rowCount)) return false;
  if (!isFiniteNumber(candidate.byteSize)) return false;
  if (!isFiniteNumber(candidate.malformedRowCount)) return false;
  if (!isFiniteNumber(candidate.usableRecordCount)) return false;
  // `!=` (nie `!==`) zámerne — `previousAccepted: undefined` (pole úplne chýba
  // za behu, alebo ho stratí JSON round-trip) sa má správať rovnako ako `null`
  // (prvý import), nikdy nedereferencovať `.rowCount` na `undefined`. Rovnaká
  // voľná kontrola je aj v `judgeSnapshot` nižšie — obe musia byť v zhode.
  if (candidate.previousAccepted != null && !isFiniteNumber(candidate.previousAccepted.rowCount)) {
    return false;
  }
  return true;
}

function limitsAreValid(limits: SnapshotLimits): boolean {
  return (
    isFiniteNumber(limits.minByteSize) &&
    isFiniteNumber(limits.absoluteMinRows) &&
    isFiniteNumber(limits.previousRowRatio)
  );
}

/** `1000000` → `"1 000 000"` — a bare integer is not readable in an operator-facing message. */
function formatThousands(n: number): string {
  return Math.trunc(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * Vyberie najčastejšiu príčinu spomedzi `unusableReasonCounts`, ale LEN keď
 * tvorí aspoň polovicu nepoužiteľných riadkov (`unusableTotal`) — inak ide o
 * rozptýlené drobné anomálie bez jednej prevažujúcej príčiny a pomenovanie
 * jednej z nich by prevádzkovateľa zavádzalo. Bez počtov (nevyplnené) alebo
 * pri nulovom/zápornom `unusableTotal` vráti `null` — dôvod potom zostáva bez
 * zmienky o príčine, presne ako predtým.
 */
function dominantUnusableReason(
  counts: Readonly<Record<string, number>> | undefined,
  unusableTotal: number,
): string | null {
  if (counts === undefined || unusableTotal <= 0) return null;
  let bestLabel: string | null = null;
  let bestCount = 0;
  for (const [label, count] of Object.entries(counts)) {
    if (count > bestCount) {
      bestCount = count;
      bestLabel = label;
    }
  }
  if (bestLabel === null || bestCount * 2 < unusableTotal) return null;
  return bestLabel;
}

/**
 * Slovak count agreement for "poškodený riadok": 1 → singular
 * (`poškodený riadok`), the LITERAL counts 2, 3, 4 → paucal (`poškodené
 * riadky`), everything else (0, 5+, and every count ≥ 10 including 22, 23,
 * 24, 32, 102 …) → plural genitive (`poškodených riadkov`). Unlike
 * Russian/Polish, Slovak does NOT re-derive the form from the last one or two
 * digits — the paucal applies only to the number itself being 2, 3 or 4, so
 * 22 takes the genitive plural exactly like 21 or 25.
 */
function formatMalformedRows(n: number): string {
  const count = Math.trunc(n);
  if (count === 1) return "1 poškodený riadok";
  if (count === 2 || count === 3 || count === 4) {
    return `${String(count)} poškodené riadky`;
  }
  return `${String(count)} poškodených riadkov`;
}

// #286 stalo sa výpadkom presne preto, lebo žiadny dôvod odmietnutia nepovedal
// prevádzkovateľovi to najdôležitejšie: že katalóg NEBOL prepísaný. Downstream
// automatizácie preto hlásili úspech, hoci dáta zmizli. Každý dôvod preto MUSÍ
// túto vetu niesť — pridáva sa na jednom mieste, nie v každom `return` zvlášť.
// Exportované, aby ju mohli zdieľať aj odmietnutia mimo `judgeSnapshot` (napr.
// zlyhané parsovanie v `ingestCatalog`, Task 5) namiesto duplikovania toho
// istého reťazca ako druhého literálu, ktorý by sa mohol nenápadne rozísť.
export const CONSEQUENCE = "Katalóg zostáva nezmenený, import môžete kedykoľvek zopakovať.";

function rejected(reason: string): SnapshotJudgement {
  return { verdict: "rejected", reason: `${reason} ${CONSEQUENCE}` };
}

export function judgeSnapshot(
  candidate: SnapshotCandidate,
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): SnapshotJudgement {
  if (!candidateIsValid(candidate) || !limitsAreValid(limits)) {
    return rejected("Údaje o stiahnutom exporte sú neplatné, import sa nevykonal.");
  }

  if (candidate.byteSize === 0) {
    return rejected("Stiahnutý súbor je prázdny (0 bajtov).");
  }
  if (candidate.byteSize < limits.minByteSize) {
    return rejected(
      `Stiahnutý súbor má len ${formatThousands(candidate.byteSize)} bajtov, minimum je ${formatThousands(limits.minByteSize)} bajtov.`,
    );
  }

  const missing = REQUIRED_COLUMNS.filter((column) => !candidate.columns.includes(column));
  if (missing.length > 0) {
    return rejected(`V exporte chýbajú povinné stĺpce: ${missing.join(", ")}.`);
  }

  if (candidate.malformedRowCount > 0) {
    return rejected(
      `Export obsahuje ${formatMalformedRows(candidate.malformedRowCount)} (počet polí nesedí s hlavičkou).`,
    );
  }

  // Rovnaká podlaha ako pomerová hranica nižšie (`previousRowRatio`), no tu sa
  // porovnáva POUŽITEĽNÝ počet voči ROZPARSOVANÉMU počtu na TOMTO exporte —
  // nezávisle od histórie. Export, ktorý prejde hlavičkovou aj (prípadnou)
  // pomerovou kontrolou, no takmer žiadny jeho riadok sa nedal použiť (napr.
  // prázdny `code` na každom riadku), inak prejde ako prijatý a blanketový
  // update potom označí celý katalóg ako chýbajúci (#277/#286 v novej podobe).
  const usableFloor = Math.floor(candidate.rowCount * limits.previousRowRatio);
  if (candidate.usableRecordCount < usableFloor) {
    const unusableTotal = candidate.rowCount - candidate.usableRecordCount;
    const dominant = dominantUnusableReason(candidate.unusableReasonCounts, unusableTotal);
    const dominantVeta = dominant === null ? "" : ` Najčastejšia príčina: ${dominant}.`;
    return rejected(
      `Export má ${String(candidate.rowCount)} riadkov, ale len ${String(candidate.usableRecordCount)} z nich sa dalo spracovať na použiteľný záznam.${dominantVeta}`,
    );
  }

  // `!=` — pozri komentár pri rovnakej kontrole v `candidateIsValid`: chýbajúci
  // (`undefined`) predchádzajúci prijatý sa berie rovnako ako `null`.
  if (candidate.previousAccepted == null) {
    if (candidate.rowCount < limits.absoluteMinRows) {
      return rejected(
        `Export má ${String(candidate.rowCount)} riadkov, minimum pre prvý import je ${String(limits.absoluteMinRows)}.`,
      );
    }
    return { verdict: "accepted" };
  }

  // Podlaha je MAXIMUM z pomerovej hranice a absolútneho minima, nikdy len
  // pomerová hranica samotná — inak sa dá ratchetnúť smerom k nule cez opakované
  // prijaté, mierne klesajúce exporty (14014 → 11211 → … → 1 → 0), pretože
  // floor(1 * 0.8) === 0 a prázdny export by prešiel presne cez túto bránu (#286).
  const floor = Math.max(
    Math.floor(candidate.previousAccepted.rowCount * limits.previousRowRatio),
    limits.absoluteMinRows,
  );
  if (candidate.rowCount < floor) {
    return rejected(
      `Export má ${String(candidate.rowCount)} riadkov, minimum odvodené z posledného prijatého importu (${String(candidate.previousAccepted.rowCount)} riadkov) je ${String(floor)}.`,
    );
  }

  return { verdict: "accepted" };
}
