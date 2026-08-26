import { useState, type JSX } from "react";
import { formatSkDate } from "../formatDate.js";
import { computeVariantTotals, formatItemCount } from "../ordersSummary.js";
import type { RiesitOrder } from "../riesitOrders.js";
import type { useOrderLinesBoard } from "../useOrderLinesBoard.js";
import { CustomerContactRowButton } from "./CustomerContactRowButton.js";
import { OrderLineRow } from "./OrderLineRow.js";
import { OrderLinesTableHead } from "./OrderLinesTableHead.js";

// issue 484 (Štěpán): jedna problémová objednávka = JEDEN kompaktný riadok
// (číslo objednávky s preklikom · meno zákazníka · počet položiek · dátum ·
// poznámka), šípka ▾ rozroluje PLNÉ položkové riadky presne ako v „Na
// objednanie" (znovupoužitý `OrderLineRow` so všetkými funkciami vrátane
// vypnutia stavu Riešiť). Vypnutie Riešiť POSLEDNEJ položky odstráni riadok z
// `board` (`keepOnlyState: "riesit"`) a keďže tento zoznam je ODVODENÝ z
// `board.suppliers` (`groupRiesitLinesByOrder`), objednávka bez riesit riadkov
// z neho automaticky vypadne pri ďalšom rendri.

type Board = ReturnType<typeof useOrderLinesBoard>;

export function RiesitOrderRow({
  order,
  canChangeState,
  board,
  onOpenCustomerContact,
}: {
  readonly order: RiesitOrder;
  readonly canChangeState: boolean;
  readonly board: Board;
  // issue 502: @ tlačidlo za menom zákazníka otvorí to isté okno na ručný
  // e-mail zákazníkovi ako „Na objednanie" (#500) — `RiesitSection` vlastní
  // zdieľaný modál (`useCustomerContactMail`).
  readonly onOpenCustomerContact: (orderCode: string, trigger: HTMLElement | null) => void;
}): JSX.Element {
  // Rozbalený/zbalený stav je lokálny per-objednávka. Kľúč zoznamu je `orderId`
  // (RiesitSection), takže inštancia (a teda aj tento stav) prežije re-render
  // pri zmene iného riadku; zmizne až keď objednávka opustí zoznam.
  const [expanded, setExpanded] = useState(false);

  // issue 62: Σ čipy opakovaného produktu — počítané nad položkami TEJTO
  // objednávky (náprotivok skupiny dodávateľa v „Na objednanie").
  const variantTotals = computeVariantTotals(order.lines);

  const note = order.comment ?? "";

  return (
    <div className="riesit-order" data-testid={`riesit-order-${order.externalOrderId}`}>
      <div className="riesit-order-head">
        <button
          type="button"
          className="btn sm ghost riesit-order-toggle"
          data-testid={`riesit-order-toggle-${order.externalOrderId}`}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Zbaliť" : "Rozbaliť"} položky objednávky ${order.externalOrderId}`}
          onClick={() => {
            setExpanded((v) => !v);
          }}
        >
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        </button>
        {/* Preklik čísla objednávky — rovnaký cieľ (Shoptet admin) ako preklik
            čísla v „Na objednanie" (`OrderLineRow`'s `.ord-admin-link`). */}
        <a
          href={order.adminUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="ord-admin-link riesit-order-code"
          aria-label={`Otvoriť objednávku ${order.externalOrderId} v administrácii Shoptet`}
          title="Otvoriť v administrácii Shoptet"
        >
          {order.externalOrderId}
        </a>
        <span className="riesit-order-customer">{order.customerName}</span>
        {/* issue 502: @ tlačidlo — hneď za menom zákazníka (VĽAVO, nikdy
            napravo, Štěpán), otvorí to isté okno na e-mail zákazníkovi ako „Na
            objednanie" (#500). Gated na `canChangeState` (server `/send`
            vyžaduje admin/manazer). `.riesit-order-count`'s `margin-left: auto`
            (app.css) drží počet+dátum vpravo, takže @ ostáva pri mene vľavo. */}
        {canChangeState && (
          <CustomerContactRowButton
            testIdKey={order.externalOrderId}
            orderCode={order.externalOrderId}
            customerName={order.customerName}
            onOpen={onOpenCustomerContact}
          />
        )}
        <span className="riesit-order-count" data-testid={`riesit-order-count-${order.externalOrderId}`}>
          {formatItemCount(order.lines.length)}
        </span>
        <span className="riesit-order-date">{formatSkDate(order.placedAt)}</span>
        {note !== "" && (
          <span className="riesit-order-note" title={note}>
            {note}
          </span>
        )}
      </div>

      {expanded && (
        <div className="orders-table-wrap">
          <table className="orders-table">
            <OrderLinesTableHead />
            <tbody>
              {order.lines.map((line) => (
                <OrderLineRow
                  key={line.lineId}
                  line={line}
                  canChangeState={canChangeState}
                  busyLineId={board.busyLineId}
                  busyOrderedLineId={board.busyOrderedLineId}
                  // V „Riešiť" niet hromadnej akcie po dodávateľovi → nikdy busy.
                  supplierBusy={false}
                  variantTotal={variantTotals.get(line.variantCode)}
                  busySupplierLineId={board.busySupplierLineId}
                  busySupplierLinkLineId={board.busySupplierLinkLineId}
                  busyCommentOrderId={board.busyCommentOrderId}
                  pendingSupplierDraft={board.supplierDrafts.draftByLineId.get(line.lineId)}
                  onChangeState={board.changeState}
                  onChangeOrdered={board.changeOrdered}
                  onAssignSupplier={board.assignSupplier}
                  onSetSupplierLink={board.setSupplierLink}
                  onChangeComment={board.changeComment}
                  onEditorActivityChange={board.onEditorActivityChange}
                  onSupplierDraftChange={board.supplierDrafts.setDraft}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
