import type { JSX, ReactNode } from "react";
import type { OrderFlagRow } from "../orderFlagsApi.js";
import { formatSkDate } from "../formatDate.js";
import { StateChip } from "./section/StateChip.js";

// issue 290 → 548: zdieľaná READ-ONLY tabuľka pre "Výmena tovaru"/"Vrátený
// tovar" a (issue 548) aj "Reklamácie". Všetky tri majú rovnaký tvar riadku
// (`ClaimOrderRow extends OrderFlagRow`), líšia sa len zdrojovým filtrom a
// drobnosťami: Reklamácie ukazujú `claimNote` namiesto `comment`, NEmajú
// „nevybavené" odznak a majú navyše akčný stĺpec (zrušiť). Tie rozdiely sú
// voliteľné props (`note`/`showUnresolved`/`actions`) — bez nich je výstup
// IDENTICKÝ s pôvodným pre Výmena/Vrátený (len tabuľka teraz nesie zdieľanú
// `.orders-table` triedu vzoru "Na objednanie").
export function OrderFlagTable<T extends OrderFlagRow>({
  testIdPrefix,
  rows,
  note = (row) => row.comment,
  showUnresolved = true,
  actions,
  actionsHeader = "Akcia",
}: {
  readonly testIdPrefix: string;
  readonly rows: readonly T[];
  readonly note?: (row: T) => string | null;
  readonly showUnresolved?: boolean;
  readonly actions?: ((row: T) => ReactNode) | undefined;
  readonly actionsHeader?: string;
}): JSX.Element {
  return (
    <div className="fs-table-wrap">
      <table className="orders-table">
        <thead>
          <tr>
            <th>Objednávka</th>
            <th>Zákazník</th>
            <th>Dátum</th>
            <th>Suma</th>
            <th>Stav</th>
            <th>Poznámka</th>
            {actions !== undefined && <th>{actionsHeader}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const poznamka = note(row);
            return (
              <tr key={row.id} data-testid={`${testIdPrefix}-${row.externalOrderId}`}>
                <td>
                  <a href={row.adminUrl} target="_blank" rel="noreferrer">
                    č. {row.externalOrderId}
                  </a>
                  {showUnresolved && row.unresolved && (
                    <StateChip base="pill" testId={`${testIdPrefix}-unresolved-${row.externalOrderId}`}>
                      nevybavené
                    </StateChip>
                  )}
                </td>
                <td>{row.customerName}</td>
                <td>{formatSkDate(row.placedAt)}</td>
                <td>{row.totalPriceWithVat === null ? "—" : `${row.totalPriceWithVat} €`}</td>
                <td>{row.statusName}</td>
                <td>{poznamka === null || poznamka === "" ? "—" : poznamka}</td>
                {actions !== undefined && <td>{actions(row)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
