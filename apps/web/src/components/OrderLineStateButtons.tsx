import type { JSX } from "react";
import type { OrderLine } from "../ordersApi.js";
import { STATE_DISPLAY_ORDER, STATE_LABELS } from "../orderLineStateLabels.js";
import type { OrderLineStateValue } from "../orderLineStates.js";

// issue 575: čisto prezentačný klaster stavových tlačidiel s PRIMITÍVNYMI props
// (idKey/state/ariaLabel/busy/onChange), aby ho vedel použiť AJ predajňový
// riadok (`FloorOrderRow`), nielen objednávkový. `idKey` skladá testidy
// (`state-select-<idKey>`/`state-btn-<s>-<idKey>`) — order line posiela `lineId`
// (testidy nezmenené, existujúce testy/e2e ostávajú), floor riadok posiela
// `floor-<noteId>-<code>` (bez kolízie, nikdy prefix `order-line-`).
export function StateButtons({
  idKey,
  state,
  ariaLabel,
  busy,
  onChange,
}: {
  readonly idKey: string;
  readonly state: OrderLine["state"];
  readonly ariaLabel: string;
  readonly busy: boolean;
  readonly onChange: (newState: OrderLineStateValue) => void;
}): JSX.Element {
  return (
    <div className="ord-state-btn-group" role="radiogroup" aria-label={ariaLabel} data-testid={`state-select-${idKey}`}>
      {STATE_DISPLAY_ORDER.map((s) => {
        const active = state === s;
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={active}
            className={"ord-state-btn ord-state-btn-" + s + (active ? " active" : "")}
            data-testid={`state-btn-${s}-${idKey}`}
            disabled={busy}
            onClick={() => {
              // Klik na UŽ aktívne tlačidlo nepošle zbytočný zápis (issue 161 —
              // presne to, čo `<select>` prirodzene robil).
              if (!active) onChange(s);
            }}
          >
            {STATE_LABELS[s]}
          </button>
        );
      })}
    </div>
  );
}

// issue 161: majiteľ, doslovne "na stav nechcem mat selektor ale 4
// tlacitka" — nahrádza pôvodný `<select>` (`OrderLineRow.tsx`) segmentovaným
// prepínačom so 4 tlačidlami, vyňaté do vlastného súboru (`OrderLineRow.tsx`
// je už na eslint `max-lines: 400` hranici, rovnaký vzor ako existujúce
// `SupplierOrderGroup.tsx`/`OrderLineRow.tsx` extrakcie, `.claude/rules/
// frontend-design.md`). Obal nesie PÔVODNÝ testid (`state-select-<lineId>`)
// aj PÔVODNÝ `aria-label`, aby existujúci e2e `getByLabel(...)` test naďalej
// nachádzal ten istý prvok — len teraz `role="radiogroup"` namiesto
// `<select>`. issue 575: telo je teraz zdieľané `StateButtons` (primitívne
// props) — obal len napĺňa order-line hodnoty, DOM/testidy 1:1 nezmenené.
export function OrderLineStateButtons({
  line,
  busyLineId,
  onChangeState,
}: {
  readonly line: OrderLine;
  readonly busyLineId: string | null;
  readonly onChangeState: (lineId: string, newState: OrderLineStateValue) => void;
}): JSX.Element {
  return (
    <StateButtons
      idKey={line.lineId}
      state={line.state}
      ariaLabel={`Zmeniť stav riadku objednávky ${line.externalOrderId} / ${line.variantCode}`}
      busy={busyLineId === line.lineId}
      onChange={(s) => {
        onChangeState(line.lineId, s);
      }}
    />
  );
}
