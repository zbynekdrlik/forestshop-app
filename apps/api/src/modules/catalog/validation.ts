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
  // Použije sa LEN vtedy, keď ešte nie je z čoho odvodiť (prvý import).
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
  if (candidate.previousAccepted !== null && !isFiniteNumber(candidate.previousAccepted.rowCount)) {
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

// #286 stalo sa výpadkom presne preto, lebo žiadny dôvod odmietnutia nepovedal
// prevádzkovateľovi to najdôležitejšie: že katalóg NEBOL prepísaný. Downstream
// automatizácie preto hlásili úspech, hoci dáta zmizli. Každý dôvod preto MUSÍ
// túto vetu niesť — pridáva sa na jednom mieste, nie v každom `return` zvlášť.
const CONSEQUENCE = "Katalóg zostáva nezmenený, import môžete kedykoľvek zopakovať.";

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
      `Stiahnutý súbor má len ${String(candidate.byteSize)} bajtov, minimum je ${formatThousands(limits.minByteSize)} bajtov.`,
    );
  }

  const missing = REQUIRED_COLUMNS.filter((column) => !candidate.columns.includes(column));
  if (missing.length > 0) {
    return rejected(`V exporte chýbajú povinné stĺpce: ${missing.join(", ")}.`);
  }

  if (candidate.malformedRowCount > 0) {
    return rejected(
      `Export obsahuje ${String(candidate.malformedRowCount)} poškodených riadkov (počet polí nesedí s hlavičkou).`,
    );
  }

  if (candidate.previousAccepted === null) {
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
