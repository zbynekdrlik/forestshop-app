import type { JSX } from "react";
import { computeVariantTotals, isLineResolved } from "../ordersSummary.js";
import { OrderLineRow } from "./OrderLineRow.js";
import { SupplierActionsPanel } from "./SupplierActionsPanel.js";
import type { OrderLine, OrderMailPreview, SupplierOpenOrders } from "../ordersApi.js";

// issue 63 — mechanicky vyňaté z `OrdersSection.tsx` (JEDNA skupina
// dodávateľa: `SupplierActionsPanel` + jej tabuľka riadkov), BEZ zmeny
// správania/markupu — `OrdersSection.tsx` bol na ~376/400 efektívnych
// riadkov (eslint `max-lines`) a pridanie stavu/callbacku pre ručné
// priradenie dodávateľa by ho poslalo cez limit. Rovnaký vzor ako
// `OrderLineRow`/`SupplierActionsPanel` extrakcia (`.claude/rules/
// frontend-design.md`) — vyňať najväčší samostatný blok, `OrdersSection.tsx`
// zostáva vlastníkom dát/stavu.
export function SupplierOrderGroup({
  group,
  hideResolved,
  canChangeState,
  busyLineId,
  busyOrderedLineId,
  busyOrderedSupplier,
  busySupplierLineId,
  onChangeState,
  onChangeOrdered,
  onAssignSupplier,
  editingEmailSupplier,
  emailDraft,
  emailBusy,
  emailError,
  onEmailDraftChange,
  onStartEditEmail,
  onSaveEmail,
  onCancelEditEmail,
  onToggleGroupOrdered,
  onCopyOrderToClipboard,
  previewSupplier,
  preview,
  previewError,
  sendBusy,
  sendResult,
  onOpenPreview,
  onClosePreview,
  onConfirmSend,
}: {
  readonly group: SupplierOpenOrders;
  readonly hideResolved: boolean;
  readonly canChangeState: boolean;
  readonly busyLineId: string | null;
  readonly busyOrderedLineId: string | null;
  readonly busyOrderedSupplier: string | null;
  // issue 63: riadok, ktorého ručné priradenie dodávateľa PRÁVE TERAZ ukladá.
  readonly busySupplierLineId: string | null;
  readonly onChangeState: (lineId: string, newState: OrderLine["state"]) => void;
  readonly onChangeOrdered: (lineId: string, ordered: boolean) => void;
  readonly onAssignSupplier: (lineId: string, supplier: string) => void;
  readonly editingEmailSupplier: string | null;
  readonly emailDraft: string;
  readonly emailBusy: boolean;
  readonly emailError: string;
  readonly onEmailDraftChange: (value: string) => void;
  readonly onStartEditEmail: (group: SupplierOpenOrders) => void;
  readonly onSaveEmail: (supplier: string) => void;
  readonly onCancelEditEmail: () => void;
  readonly onToggleGroupOrdered: (supplier: string, ordered: boolean) => void;
  readonly onCopyOrderToClipboard: (supplier: string) => void;
  readonly previewSupplier: string | null;
  readonly preview: OrderMailPreview | null;
  readonly previewError: string;
  readonly sendBusy: boolean;
  readonly sendResult: { readonly supplier: string; readonly message: string } | null;
  readonly onOpenPreview: (supplier: string) => void;
  readonly onClosePreview: () => void;
  readonly onConfirmSend: (supplier: string) => void;
}): JSX.Element | null {
  const visibleLines = hideResolved ? group.lines.filter((line) => !isLineResolved(line)) : group.lines;
  if (visibleLines.length === 0) return null;
  // issue 62: súčty sa počítajú nad CELOU (nefiltrovanou) skupinou
  // dodávateľa, nikdy nad `visibleLines` — chip nesmie zmiznúť/zmeniť
  // hodnotu len preto, že prepínač "skryť vybavené" skryl sesterský riadok
  // toho istého produktu (`.claude/rules/orders.md`).
  const variantTotals = computeVariantTotals(group.lines);

  return (
    <div className="order-group" data-testid={`supplier-${group.supplier}`}>
      <SupplierActionsPanel
        group={group}
        canChangeState={canChangeState}
        editingEmailSupplier={editingEmailSupplier}
        emailDraft={emailDraft}
        emailBusy={emailBusy}
        emailError={emailError}
        onEmailDraftChange={onEmailDraftChange}
        onStartEditEmail={onStartEditEmail}
        onSaveEmail={onSaveEmail}
        onCancelEditEmail={onCancelEditEmail}
        busyOrderedSupplier={busyOrderedSupplier}
        busyOrderedLineId={busyOrderedLineId}
        onToggleGroupOrdered={onToggleGroupOrdered}
        onCopyOrderToClipboard={onCopyOrderToClipboard}
        previewSupplier={previewSupplier}
        preview={preview}
        previewError={previewError}
        sendBusy={sendBusy}
        sendResult={sendResult}
        onOpenPreview={onOpenPreview}
        onClosePreview={onClosePreview}
        onConfirmSend={onConfirmSend}
      />
      <table className="orders-table">
        <thead>
          <tr>
            {/* issue 60: odškrtávacie políčko — JEDINÉ miesto na obrazovke,
                ktoré sa smie volať "Objednané" (viď `STATE_LABELS` a stĺpec
                dátumu nižšie, obe premenované, aby nekolidovali). */}
            <th>Objednané</th>
            <th>Objednávka</th>
            <th>Zákazník</th>
            <th>Kód</th>
            <th>Produkt</th>
            <th>Veľkosť</th>
            <th>Množstvo</th>
            <th>Dodávateľ</th>
            {/* issue 63: ručné priradenie dodávateľa — prázdne pre riadky,
                ktoré ho nepotrebujú (`line.supplierAssignable === false`). */}
            <th>Priradenie dodávateľa</th>
            <th>Stav</th>
            <th>Dátum objednávky</th>
            <th>Komentár</th>
          </tr>
        </thead>
        <tbody>
          {visibleLines.map((line) => (
            <OrderLineRow
              key={line.lineId}
              line={line}
              canChangeState={canChangeState}
              busyLineId={busyLineId}
              busyOrderedLineId={busyOrderedLineId}
              // Review of PR 75, finding 6: kým hromadná akcia pre TOHTO
              // dodávateľa beží, žiadny riadok jeho skupiny sa nesmie dať
              // meniť per-riadkovo naraz.
              supplierBusy={busyOrderedSupplier === group.supplier}
              variantTotal={variantTotals.get(line.variantCode)}
              busySupplierLineId={busySupplierLineId}
              onChangeState={onChangeState}
              onChangeOrdered={onChangeOrdered}
              onAssignSupplier={onAssignSupplier}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
