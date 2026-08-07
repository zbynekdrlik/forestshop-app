import type { JSX } from "react";
import type { OrderFlagRow } from "../orderFlagsApi.js";
import { formatSkDate } from "../formatDate.js";

// issue 290: zdieľaná READ-ONLY tabuľka pre "Výmena tovaru"/"Vrátený tovar"
// — obe stránky majú IDENTICKÝ tvar riadku (`OrderFlagRow`), líšia sa len
// zdrojovým filtrom (`ExchangeOrdersSection.tsx`/`ReturnedOrdersSection
// .tsx`). "Reklamácie" má VLASTNÚ tabuľku (`ClaimOrdersSection.tsx`) — nesie
// navyše poznámku obsluhy a tlačidlo na zrušenie, spoločný tvar by ich
// musel robiť voliteľné pre polovicu použití zbytočne.
export function OrderFlagTable({ testIdPrefix, rows }: { readonly testIdPrefix: string; readonly rows: readonly OrderFlagRow[] }): JSX.Element {
  return (
    <div className="fs-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Objednávka</th>
            <th>Zákazník</th>
            <th>Dátum</th>
            <th>Suma</th>
            <th>Stav</th>
            <th>Poznámka</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-testid={`${testIdPrefix}-${row.externalOrderId}`}>
              <td>
                <a href={row.adminUrl} target="_blank" rel="noreferrer">
                  č. {row.externalOrderId}
                </a>
                {row.unresolved && (
                  <span className="pill" data-testid={`${testIdPrefix}-unresolved-${row.externalOrderId}`}>
                    nevybavené
                  </span>
                )}
              </td>
              <td>{row.customerName}</td>
              <td>{formatSkDate(row.placedAt)}</td>
              <td>{row.totalPriceWithVat === null ? "—" : `${row.totalPriceWithVat} €`}</td>
              <td>{row.statusName}</td>
              <td>{row.comment === null || row.comment === "" ? "—" : row.comment}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
