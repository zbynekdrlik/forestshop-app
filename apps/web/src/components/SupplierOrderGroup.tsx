import type { JSX } from "react";
import { computeVariantTotals, isFloorRowHidden, isLineHiddenByFilter } from "../ordersSummary.js";
import type { SupplierDraftsApi } from "../useSupplierDrafts.js";
import { FloorOrderRow } from "./FloorOrderRow.js";
import { OrderLineRow } from "./OrderLineRow.js";
import { OrderLinesTableHead } from "./OrderLinesTableHead.js";
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
  dirtyEditorLineIds,
  onEditorActivityChange,
  supplierDrafts,
  canChangeState,
  busyLineId,
  busyOrderedLineId,
  busyOrderedSupplier,
  busySupplierLineId,
  busySupplierLinkLineId,
  busyCommentOrderId,
  busyFloorRowKey,
  onChangeState,
  onChangeOrdered,
  onChangeFloorOrdered,
  onAssignSupplier,
  onSetSupplierLink,
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
  onOpenCustomerContact,
  selectedSupplier,
  highlightVariantCode,
}: {
  readonly group: SupplierOpenOrders;
  readonly hideResolved: boolean;
  // issue 529: variant, na ktorý sa práve deep-linkovalo z „Nedostupné tovary"
  // (📦, `?tab=orders&highlight=<kód>`) — riadky s týmto `variantCode` sa
  // vizuálne zvýraznia. `null` = žiadne zvýraznenie.
  readonly highlightVariantCode: string | null;
  // issue 263: predané ĎALEJ do `SupplierActionsPanel` (jeho `.toorder-
  // supplier` hlavičky `active` stav) — `OrdersSection.tsx`'s
  // `filteredGroups` už aj tak vykresľuje LEN vybranú skupinu, keď je
  // niečo vybrané, takže tento prop je vždy buď `null`, alebo presne
  // `group.supplier`.
  readonly selectedSupplier: string | null;
  // issue 149: riadky s PRÁVE TERAZ otvorenou/rozpísanou úpravou — výnimka z
  // `hideResolved` filtra nižšie, aby vybavený riadok nezmizol spod rúk
  // manažérovi, ktorý doň ešte niečo píše (`OrdersSection.tsx`'s komentár).
  readonly dirtyEditorLineIds: ReadonlySet<string>;
  readonly onEditorActivityChange: (lineId: string, active: boolean) => void;
  // issue 151: rozpísaný, ešte neuložený koncept priradenia dodávateľa,
  // zdvihnutý na úroveň `OrdersSection` (`useSupplierDrafts.ts` vysvetľuje
  // prečo — prežije presun riadku medzi skupinami, čo lokálny stav v
  // `OrderLineRow` neprežije).
  readonly supplierDrafts: SupplierDraftsApi;
  readonly canChangeState: boolean;
  readonly busyLineId: string | null;
  readonly busyOrderedLineId: string | null;
  readonly busyOrderedSupplier: string | null;
  // issue 63: riadok, ktorého ručné priradenie dodávateľa PRÁVE TERAZ ukladá.
  readonly busySupplierLineId: string | null;
  // issue 121: riadok, ktorého odkaz na dodávateľa PRÁVE TERAZ ukladá.
  readonly busySupplierLinkLineId: string | null;
  // issue 64: objednávka, ktorej poznámka PRÁVE TERAZ ukladá.
  readonly busyCommentOrderId: string | null;
  // issue 480: kľúč (`noteId::variantCode`) predajňového riadku, ktorého zápis
  // „objednané" PRÁVE TERAZ prebieha.
  readonly busyFloorRowKey: string | null;
  readonly onChangeState: (lineId: string, newState: OrderLine["state"]) => void;
  readonly onChangeOrdered: (lineId: string, ordered: boolean) => void;
  // issue 480: prepnutie „objednané" na predajňovom riadku.
  readonly onChangeFloorOrdered: (noteId: string, variantCode: string, ordered: boolean) => void;
  readonly onAssignSupplier: (lineId: string, supplier: string) => void;
  // issue 166: `boolean` návratová hodnota — pozri `OrderLineRow.tsx`'s komentár.
  readonly onSetSupplierLink: (lineId: string, url: string) => boolean;
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
  // issue 500: @ tlačidlo na riadku otvorí okno na ručný e-mail zákazníkovi
  // (`OrdersSection.tsx` vlastní modál). Prechádza ĎALEJ do `OrderLineRow`.
  readonly onOpenCustomerContact: (orderCode: string, trigger: HTMLElement | null) => void;
}): JSX.Element | null {
  const visibleLines = group.lines.filter((line) => !isLineHiddenByFilter(line, hideResolved, dirtyEditorLineIds));
  // issue 480: predajňové riadky skupiny (skryté pri „skryť vybavené", keď sú
  // objednané). Skupina zmizne LEN keď nemá ani viditeľnú objednávku ANI
  // viditeľný predajňový riadok — inak by floor-only skupina vôbec nevykreslila.
  const visibleFloorRows = (group.floorRows ?? []).filter((row) => !isFloorRowHidden(row, hideResolved));
  if (visibleLines.length === 0 && visibleFloorRows.length === 0) return null;
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
        selectedSupplier={selectedSupplier}
        busyFloorRowKey={busyFloorRowKey}
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
          {/* issue 484: colgroup(9)+thead vyčlenené do `OrderLinesTableHead`
              (zdieľané s rozrolovaním sekcie „Riešiť") — DOM bajt-identický. */}
          <OrderLinesTableHead />
          <tbody>
            {visibleLines.map((line) => (
              <OrderLineRow
                key={line.lineId}
                line={line}
                highlighted={highlightVariantCode !== null && line.variantCode === highlightVariantCode}
                canChangeState={canChangeState}
                busyLineId={busyLineId}
                busyOrderedLineId={busyOrderedLineId}
                // Review of PR 75, finding 6: kým hromadná akcia pre TOHTO
                // dodávateľa beží, žiadny riadok jeho skupiny sa nesmie dať
                // meniť per-riadkovo naraz.
                supplierBusy={busyOrderedSupplier === group.supplier}
                variantTotal={variantTotals.get(line.variantCode)}
                busySupplierLineId={busySupplierLineId}
                busySupplierLinkLineId={busySupplierLinkLineId}
                busyCommentOrderId={busyCommentOrderId}
                pendingSupplierDraft={supplierDrafts.draftByLineId.get(line.lineId)}
                onChangeState={onChangeState}
                onChangeOrdered={onChangeOrdered}
                onAssignSupplier={onAssignSupplier}
                onSetSupplierLink={onSetSupplierLink}
                onChangeComment={onChangeComment}
                onEditorActivityChange={onEditorActivityChange}
                onSupplierDraftChange={supplierDrafts.setDraft}
                onOpenCustomerContact={onOpenCustomerContact}
              />
            ))}
            {/* issue 480: predajňové riadky POD riadkami objednávok tej istej
                skupiny dodávateľa — v tej istej tabuľke (rovnaké stĺpce), bez
                stavových tlačidiel, s 🛍️ namiesto čísla objednávky. */}
            {visibleFloorRows.map((row) => (
              <FloorOrderRow
                key={`${row.noteId}::${row.variantCode}`}
                row={row}
                canChangeState={canChangeState}
                busyFloorRowKey={busyFloorRowKey}
                // Review of PR 75/76 (issue 60) obojsmerný busy-guard: kým beží
                // hromadná akcia skupiny, jednotlivý floor riadok sa nedá meniť.
                supplierBusy={busyOrderedSupplier === group.supplier}
                onChangeOrdered={onChangeFloorOrdered}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
