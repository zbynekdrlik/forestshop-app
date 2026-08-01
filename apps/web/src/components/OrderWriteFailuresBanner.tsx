import type { JSX } from "react";
import { formatWriteFailuresHeading, type OrderWriteFailure } from "../ordersWriteFailures.js";

// issue 66: kumulatívny banner "⚠️ Nepodarilo sa uložiť N položiek" — vyňaté
// do vlastného komponentu (rovnaký vzor extrakcie ako `OrderLineRow`/
// `SupplierOrderGroup`, `.claude/rules/frontend-design.md`), aby zostal
// jednoducho testovateľný samostatne. `role="alert"` na koreňovom prvku
// preberá existujúci globálny reset (`app.css`'s `[role="alert"]`) —
// farba/padding/radius appka nikde nedefinuje druhýkrát.
export function OrderWriteFailuresBanner({
  failures,
  onDismiss,
}: {
  readonly failures: readonly OrderWriteFailure[];
  readonly onDismiss: () => void;
}): JSX.Element | null {
  if (failures.length === 0) return null;
  return (
    <div className="order-write-failures" role="alert" data-testid="order-write-failures">
      <div className="order-write-failures-head">
        <span>{formatWriteFailuresHeading(failures.length)}</span>
        <button
          type="button"
          className="btn sm ghost"
          aria-label="Zavrieť hlásenie o neuložených zmenách"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
      <ul>
        {failures.map((f) => (
          <li key={f.id} data-testid={`order-write-failure-${f.id}`}>
            {f.what}
            {f.where !== "" ? ` — ${f.where}` : ""}
            {f.detail !== "" ? ` (${f.detail})` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
