// Brána prijatia snapshotu. Čistá funkcia bez I/O — presne preto sa dá otestovať
// jedným prípadom na každé historické zlyhanie (#277, #281, #286).

/**
 * Stĺpce, bez ktorých sa export nedá spracovať. Zoznam je zámerne krátky: pokrýva
 * identitu, cenu s menou, sklad a dostupnosť. Chýbajúci `supplier` bol príčinou
 * #281 — plnohodnotný export bez tohto stĺpca prešiel, lebo sa stĺpce nekontrolovali.
 */
export const REQUIRED_COLUMNS: readonly string[] = [
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
];

export interface SnapshotLimits {
  readonly minByteSize: number;
  readonly absoluteMinRows: number;
  readonly previousRowRatio: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  // Reálny export má ~56 MB; 1 MB je hranica „toto zjavne nie je celý katalóg".
  minByteSize: 1_000_000,
  // Použije sa LEN vtedy, keď ešte nie je z čoho odvodiť (prvý import).
  absoluteMinRows: 1_000,
  previousRowRatio: 0.8,
};

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

export function judgeSnapshot(
  candidate: SnapshotCandidate,
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): SnapshotJudgement {
  if (candidate.byteSize === 0) {
    return { verdict: "rejected", reason: "Stiahnutý súbor je prázdny (0 bajtov)." };
  }
  if (candidate.byteSize < limits.minByteSize) {
    return {
      verdict: "rejected",
      reason: `Stiahnutý súbor má len ${String(candidate.byteSize)} bajtov, minimum je ${String(limits.minByteSize)}.`,
    };
  }

  const missing = REQUIRED_COLUMNS.filter((column) => !candidate.columns.includes(column));
  if (missing.length > 0) {
    return {
      verdict: "rejected",
      reason: `V exporte chýbajú povinné stĺpce: ${missing.join(", ")}.`,
    };
  }

  if (candidate.malformedRowCount > 0) {
    return {
      verdict: "rejected",
      reason: `Export obsahuje ${String(candidate.malformedRowCount)} poškodených riadkov (počet polí nesedí s hlavičkou).`,
    };
  }

  if (candidate.previousAccepted === null) {
    if (candidate.rowCount < limits.absoluteMinRows) {
      return {
        verdict: "rejected",
        reason: `Export má ${String(candidate.rowCount)} riadkov, minimum pre prvý import je ${String(limits.absoluteMinRows)}.`,
      };
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
    return {
      verdict: "rejected",
      reason: `Export má ${String(candidate.rowCount)} riadkov, minimum odvodené z posledného prijatého snapshotu (${String(candidate.previousAccepted.rowCount)} riadkov) je ${String(floor)}.`,
    };
  }

  return { verdict: "accepted" };
}
