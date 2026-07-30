import type { JSX } from "react";
import type { OrderLine } from "../ordersApi.js";

// issue 60: `objednane` je VÝCHODISKOVÝ stav riadku (pred tým, než sa
// čokoľvek stane), NIE potvrdenie, že manažér objednal — preto sa nazýva
// "Nevybavené", nie "Objednané" (to slovo teraz patrí VÝLUČNE odškrtávaciemu
// políčku v tomto riadku, `OrderLine["ordered"]`, aby appka nemala na jednej
// obrazovke tri rôzne veci s tým istým názvom).
export const STATE_LABELS: Record<OrderLine["state"], string> = {
  objednane: "Nevybavené",
  caka_sa: "Čaká sa",
  skladom: "Skladom",
  nedostupne: "Nedostupné",
};

// Jeden riadok tabuľky "Na objednanie" — vyčlenené z `OrdersSection.tsx`
// (issue 60 pridalo odškrtávacie políčko + premenovaný stĺpec dátumu, čo
// poslalo pôvodný súbor cez eslint `max-lines: 400`, `.claude/rules/testing.md`).
export function OrderLineRow({
  line,
  canChangeState,
  busyLineId,
  busyOrderedLineId,
  supplierBusy,
  onChangeState,
  onChangeOrdered,
}: {
  readonly line: OrderLine;
  readonly canChangeState: boolean;
  readonly busyLineId: string | null;
  readonly busyOrderedLineId: string | null;
  // Review of PR 75, finding 6: TRUE, keď práve prebieha hromadné "označiť/
  // zrušiť skupinu ako objednané" PRE DODÁVATEĽA tohto riadku
  // (`OrdersSection.tsx`'s `busyOrderedSupplier === group.supplier`) —
  // nezávislé od `busyOrderedLineId` (vlastný per-riadkový zápis). Bez toho
  // mohol manažér kliknúť na tento riadok ešte kým hromadný zápis pre celú
  // skupinu bežal, čo krátkodobo rozhádzalo optimistický UI (posledný zápis
  // vyhrá, žiadna strata dát, len zmätočné UX).
  readonly supplierBusy: boolean;
  readonly onChangeState: (lineId: string, newState: OrderLine["state"]) => void;
  readonly onChangeOrdered: (lineId: string, ordered: boolean) => void;
}): JSX.Element {
  return (
    <tr
      className={"order-row state-" + line.state + (line.ordered ? " ordered" : "")}
      data-testid={`order-line-${line.lineId}`}
    >
      <td>
        <input
          type="checkbox"
          data-testid={`ordered-checkbox-${line.lineId}`}
          aria-label={`Označiť riadok objednávky ${line.externalOrderId} / ${line.variantCode} ako objednané u dodávateľa`}
          checked={line.ordered}
          disabled={!canChangeState || busyOrderedLineId === line.lineId || supplierBusy}
          onChange={(e) => {
            onChangeOrdered(line.lineId, e.target.checked);
          }}
        />
      </td>
      <td>{line.externalOrderId}</td>
      <td>{line.customerName}</td>
      <td>{line.variantCode}</td>
      <td>{line.variantName}</td>
      <td>{line.sizeLabel ?? "—"}</td>
      <td className="ord-qty">{line.quantity} ks</td>
      <td className="ord-supplier-cell" data-testid={`supplier-link-${line.lineId}`}>
        {line.supplierUrl !== null ? (
          <a
            href={line.supplierUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="ord-supplier-link"
            // issue 72: variantName sám nestačí — dva riadky toho istého
            // produktu v rôznych veľkostiach majú zhodný variantName, líšia
            // sa len variantCode.
            aria-label={`Odkaz na dodávateľa — ${line.variantName} (${line.variantCode})`}
          >
            Odkaz na dodávateľa
          </a>
        ) : line.supplierNote !== null ? (
          <span className="ord-supplier-note" title={line.supplierNote}>
            {line.supplierNote}
          </span>
        ) : line.externalCode === null ? (
          "—"
        ) : null}
        {line.externalCode !== null && <div className="ord-supplier-code">kód {line.externalCode}</div>}
      </td>
      <td>
        {canChangeState ? (
          <select
            // Code review finding (#25): pôvodne bez slova "stav" v
            // aria-labeli (obchádzka Playwright's substring
            // `getByLabel("Stav")` kolízie s katalógovým filtrom), čo by
            // čítačke obrazovky neoznámilo, čo tento prvok robí. Skutočná
            // oprava patrí na stranu KOLÍDUJÚCEHO testu (`catalog.spec.ts`
            // teraz používa `{ exact: true }`), nie na obetovanie
            // prístupnosti tu — tento select smie mať plnohodnotný popis.
            aria-label={`Zmeniť stav riadku objednávky ${line.externalOrderId} / ${line.variantCode}`}
            data-testid={`state-select-${line.lineId}`}
            className="ord-state-select"
            value={line.state}
            disabled={busyLineId === line.lineId}
            onChange={(e) => {
              onChangeState(line.lineId, e.target.value as OrderLine["state"]);
            }}
          >
            {(Object.keys(STATE_LABELS) as OrderLine["state"][]).map((s) => (
              <option key={s} value={s}>
                {STATE_LABELS[s]}
              </option>
            ))}
          </select>
        ) : (
          STATE_LABELS[line.state]
        )}
      </td>
      <td>{new Date(line.placedAt).toLocaleDateString("sk-SK")}</td>
      <td>{line.comment ?? "—"}</td>
    </tr>
  );
}
