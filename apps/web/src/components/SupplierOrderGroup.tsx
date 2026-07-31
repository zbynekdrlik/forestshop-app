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
  busyCommentOrderId,
  onChangeState,
  onChangeOrdered,
  onAssignSupplier,
  onChangeComment,
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
  // issue 64: objednávka, ktorej poznámka PRÁVE TERAZ ukladá.
  readonly busyCommentOrderId: string | null;
  readonly onChangeState: (lineId: string, newState: OrderLine["state"]) => void;
  readonly onChangeOrdered: (lineId: string, ordered: boolean) => void;
  readonly onAssignSupplier: (lineId: string, supplier: string) => void;
  readonly onChangeComment: (orderId: string, comment: string | null) => void;
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
      {/* issue 95: vlastný vodorovný posuvný obal — stránka (`.main-wide`)
          sa sama nikdy neposúva, posúva sa (keď treba) len táto tabuľka.
          `table-layout: fixed` + `<colgroup>` dávajú stĺpcom percentuálne
          šírky (`app.css`'s `.col-*`) namiesto automatického rozloženia. 13
          pôvodných stĺpcov je teraz 9 — VEĽKOSŤ zlúčená do KÓD (issue 95),
          PRIRADENIE DODÁVATEĽA do DODÁVATEĽ (issue 95), POZNÁMKA E-SHOPU do
          POZNÁMOK (issue 95), a stĺpec KÓD celý ODSTRÁNENÝ (issue 117,
          majiteľ: "kody produktov vobec nepouzivame ... zaberaju miesto") —
          uvoľnená šírka ide do PRODUKTU/DODÁVATEĽA (`app.css`'s `.col-*`
          komentár), presne kam majiteľ žiadal. */}
      <div className="orders-table-wrap">
        <table className="orders-table">
          <colgroup>
            <col className="col-ordered" />
            <col className="col-order" />
            <col className="col-customer" />
            <col className="col-product" />
            <col className="col-qty" />
            <col className="col-supplier" />
            <col className="col-state" />
            <col className="col-date" />
            <col className="col-notes" />
          </colgroup>
          <thead>
            <tr>
              {/* issue 105 bod 1: pri 1280px (tabuľkin skutočný floor —
                  `min-width: 64rem`) sa jednoslovné VEĽKÉ hlavičky
                  ("OBJEDNANÉ"/"OBJEDNÁVKA"/"MNOŽSTVO"/"OBJEDNÁVKY") nezmestili
                  do svojich úzkych stĺpcov a pretekali do suseda (zmerané
                  `th.scrollWidth`). Namiesto širších percent (väčší diff,
                  riziko pre PRODUKT/DODÁVATEĽ) sú 4 popisky skrátené — plný
                  význam nesie `title`. Checkbox stĺpec: JEDINÉ miesto na
                  obrazovke, ktoré sa smie týkať "objednané u dodávateľa" (viď
                  `STATE_LABELS`/dátumový stĺpec nižšie, aby sa nekolidovalo). */}
              <th title="Objednané u dodávateľa (zaškrtávacie políčko)" aria-label="Objednané u dodávateľa">
                ✓
              </th>
              <th title="Číslo objednávky (klik na kód v riadku otvorí objednávku v administrácii Shoptet)">
                Č. obj.
              </th>
              <th>Zákazník</th>
              <th>Produkt</th>
              <th title="Množstvo (počet kusov)">Ks</th>
              <th title="Dodávateľ z katalógu, alebo ručné priradenie pri produkte bez katalógového dodávateľa">
                Dodávateľ
              </th>
              <th>Stav</th>
              <th title="Dátum objednávky">Dátum obj.</th>
              <th title="Poznámka zákazníka z e-shopu (na čítanie) + vlastná poznámka tímu">Poznámky</th>
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
                busyCommentOrderId={busyCommentOrderId}
                onChangeState={onChangeState}
                onChangeOrdered={onChangeOrdered}
                onAssignSupplier={onAssignSupplier}
                onChangeComment={onChangeComment}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
