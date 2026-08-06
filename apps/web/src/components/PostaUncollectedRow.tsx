import type { JSX } from "react";
import { formatSkDate } from "../formatDate.js";
import type { PostaUncollectedShipment } from "../postaUncollectedApi.js";

// Vydelené z `PostaUncollectedSection.tsx` (issue 172) — rovnaký vzor ako
// `OrderLineRow.tsx`'s vydelenie z `OrdersSection.tsx` (`.claude/rules/
// frontend-design.md`): opakovaná per-riadková JSX jednotka je zvyčajne
// najsamostatnejší kus, ktorý sa dá vytiahnuť ako prvý pri raste súboru.
export function PostaUncollectedRow({
  shipment,
  onPreview,
}: {
  readonly shipment: PostaUncollectedShipment;
  readonly onPreview: (packageNumber: string) => void;
}): JSX.Element {
  return (
    <tr data-testid={`posta-row-${shipment.packageNumber}`}>
      <td>
        <a href={shipment.trackingLink} target="_blank" rel="noreferrer">
          {shipment.packageNumber}
        </a>
      </td>
      <td>{shipment.officeName !== "" ? shipment.officeName : "—"}</td>
      <td>
        <a href={shipment.adminLink} target="_blank" rel="noreferrer">
          {shipment.orderCode}
        </a>
      </td>
      <td>
        {shipment.name}
        {shipment.phone !== "" && <div className="posta-phone">{shipment.phone}</div>}
      </td>
      <td>{shipment.daysAtPost}</td>
      <td>{shipment.retainedTill !== "" ? formatSkDate(shipment.retainedTill) : "čo najskôr"}</td>
      <td>
        {shipment.count}/4{" "}
        {shipment.callNeeded && (
          <span className="posta-call-needed" data-testid={`posta-call-needed-${shipment.packageNumber}`}>
            ⚠️ TREBA ZAVOLAŤ
          </span>
        )}
      </td>
      <td>{formatSkDate(shipment.lastSentAt)}</td>
      <td>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            onPreview(shipment.packageNumber);
          }}
        >
          👁 Náhľad
        </button>
      </td>
    </tr>
  );
}
