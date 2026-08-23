import type { JSX } from "react";
import type { OrderLine } from "../ordersApi.js";
import { STATE_DISPLAY_ORDER, STATE_LABELS } from "../orderLineStateLabels.js";

// issue 161: majiteľ, doslovne "na stav nechcem mat selektor ale 4
// tlacitka" — nahrádza pôvodný `<select>` (`OrderLineRow.tsx`) segmentovaným
// prepínačom so 4 tlačidlami, vyňaté do vlastného súboru (`OrderLineRow.tsx`
// je už na eslint `max-lines: 400` hranici, rovnaký vzor ako existujúce
// `SupplierOrderGroup.tsx`/`OrderLineRow.tsx` extrakcie, `.claude/rules/
// frontend-design.md`). Obal nesie PÔVODNÝ testid (`state-select-<lineId>`)
// aj PÔVODNÝ `aria-label`, aby existujúci e2e `getByLabel(...)` test naďalej
// nachádzal ten istý prvok — len teraz `role="radiogroup"` namiesto
// `<select>`. Rovnaké volanie na server (`onChangeState`) a rovnaká
// optimistická logika ako predtým — mení sa LEN ovládací prvok.
export function OrderLineStateButtons({
  line,
  busyLineId,
  onChangeState,
}: {
  readonly line: OrderLine;
  readonly busyLineId: string | null;
  readonly onChangeState: (lineId: string, newState: OrderLine["state"]) => void;
}): JSX.Element {
  const busy = busyLineId === line.lineId;
  return (
    <div
      className="ord-state-btn-group"
      role="radiogroup"
      aria-label={`Zmeniť stav riadku objednávky ${line.externalOrderId} / ${line.variantCode}`}
      data-testid={`state-select-${line.lineId}`}
    >
      {STATE_DISPLAY_ORDER.map((s) => {
        const active = line.state === s;
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={active}
            className={"ord-state-btn ord-state-btn-" + s + (active ? " active" : "")}
            data-testid={`state-btn-${s}-${line.lineId}`}
            disabled={busy}
            onClick={() => {
              // issue 161: klik na UŽ aktívne tlačidlo nepošle zbytočný
              // zápis na server — presne to, čo `<select>` prirodzene robil
              // (výber tej istej `<option>` nikdy nevyvolal `onChange`).
              if (!active) onChangeState(line.lineId, s);
            }}
          >
            {STATE_LABELS[s]}
          </button>
        );
      })}
    </div>
  );
}
