import type { JSX } from "react";
import type { OrderMailPreview, SupplierOpenOrders } from "../ordersApi.js";
import { summarizeOrderLines } from "../ordersSummary.js";
import { SHOW_ORDER_MAIL_ACTIONS } from "./orderScreenFlags.js";

// issue 61 — mechanicky vyňaté z `OrdersSection.tsx` (hlavička skupiny +
// e-mailový kontakt (#31) + hromadné akcie + náhľad/odoslanie mailom), BEZ
// zmeny správania alebo markupu — `OrdersSection.tsx` bol už na hranici
// eslint `max-lines: 400` (`.claude/rules/testing.md`) a pridanie filtrovacích
// chipov/súhrnu (issue 61) by ho poslalo cez limit. Rovnaký vzor ako
// `OrderLineRow` extrakcia (`.claude/rules/frontend-design.md`): vyňať
// najväčší samostatný blok, nechať `OrdersSection.tsx` vlastníkom dát/stavu.
export function SupplierActionsPanel({
  group,
  canChangeState,
  editingEmailSupplier,
  emailDraft,
  emailBusy,
  emailError,
  onEmailDraftChange,
  onStartEditEmail,
  onSaveEmail,
  onCancelEditEmail,
  busyOrderedSupplier,
  busyOrderedLineId,
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
  selectedSupplier,
  busyFloorRowKey,
}: {
  readonly group: SupplierOpenOrders;
  readonly canChangeState: boolean;
  readonly editingEmailSupplier: string | null;
  readonly emailDraft: string;
  readonly emailBusy: boolean;
  readonly emailError: string;
  readonly onEmailDraftChange: (value: string) => void;
  readonly onStartEditEmail: (group: SupplierOpenOrders) => void;
  readonly onSaveEmail: (supplier: string) => void;
  readonly onCancelEditEmail: () => void;
  readonly busyOrderedSupplier: string | null;
  readonly busyOrderedLineId: string | null;
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
  // issue 263: `.toorder-supplier` (hlavička skupiny nižšie) je VEDĽAJŠÍ
  // nosič tých istých troch stavov ako filtračný čip (`OrdersToolbar.tsx`) —
  // `active` presne vtedy, keď je TÁTO skupina PRÁVE TERAZ vybraný filter.
  readonly selectedSupplier: string | null;
  // issue 480: kľúč (`noteId::variantCode`) predajňového riadku, ktorého zápis
  // „objednané" PRÁVE TERAZ prebieha — hromadné tlačidlo skupiny sa musí
  // znefunkčniť aj kým beží per-floor-row zápis TEJTO skupiny (obojsmerný
  // busy-guard, issue 60).
  readonly busyFloorRowKey: string | null;
}): JSX.Element {
  // Riadky, ktoré ešte treba objednať u dodávateľa (rovnaký zámer ako stará
  // appka's `outstandingOf`/`!isHandled`, #31) — východiskový stav pred tým,
  // než manažér čokoľvek ručne posunie ďalej. Toto gejtuje LEN tlačidlo
  // "odoslať objednávku mailom" (server-strana `mail.ts` filtruje rovnako) —
  // je to NEZÁVISLÉ od `ordered` príznaku (issue 60), mail sa dá
  // odoslať/skopírovať bez ohľadu na to, či je riadok už odškrtnutý. Jediné
  // miesto, ktoré túto konštantu po extrakcii (issue 61) potrebuje.
  const outstandingState = "objednane";
  // issue 480: predajňové riadky skupiny (server ich vždy posiela, `?? []`
  // poistka pre staré testové literály bez tohto poľa).
  const floorRows = group.floorRows ?? [];
  // issue 480: skupina je „všetko objednané" (pre smer aj popis hromadného
  // tlačidla) keď sú objednané VŠETKY riadky objednávok AJ všetky predajňové
  // riadky. `[].every() === true`, takže skupina bez floor riadkov sa správa
  // presne ako doteraz.
  const allOrdered = group.lines.every((l) => l.ordered) && floorRows.every((r) => r.ordered);
  // issue 263/480: rovnaký výpočet "done" ako čip (`OrdersToolbar.tsx`), aby
  // OBIDVA nosiče zhodne zobrazili TÚ ISTÚ farbu — rozšírené o predajňové riadky
  // (skupina je „done" len keď je vybavené VŠETKO: objednávky aj predajňa).
  const done =
    group.lines.length + floorRows.length > 0 &&
    summarizeOrderLines(group.lines).remaining === 0 &&
    floorRows.every((r) => r.ordered);
  // issue 480: hromadné tlačidlo je znefunkčnené aj kým beží per-floor-row zápis
  // niektorého riadku TEJTO skupiny (mirror `busyOrderedLineId`, obojsmerný
  // busy-guard z issue 60).
  const floorBusyInGroup =
    busyFloorRowKey !== null && floorRows.some((r) => `${r.noteId}::${r.variantCode}` === busyFloorRowKey);
  const isSelected = selectedSupplier === group.supplier;

  return (
    <>
      <div className={"toorder-supplier" + (done ? " done" : "") + (isSelected ? " active" : "")}>
        {/* issue 480: počet zahŕňa aj predajňové riadky, aby skupina LEN s
            predajňovými riadkami neukazovala „0 riadky". */}
        <span className="tosup-label">
          {group.supplier} — {group.lines.length + floorRows.length}{" "}
          {group.lines.length + floorRows.length === 1 ? "riadok" : "riadky"}
        </span>
        <div className="tosup-contact" data-testid={`supplier-contact-${group.supplier}`}>
          {editingEmailSupplier === group.supplier ? (
            <>
              <input
                className="tosup-emailinput"
                aria-label={`E-mail dodávateľa ${group.supplier}`}
                type="email"
                value={emailDraft}
                disabled={emailBusy}
                onChange={(e) => {
                  onEmailDraftChange(e.target.value);
                }}
              />
              <button
                type="button"
                className="btn sm good"
                disabled={emailBusy}
                onClick={() => {
                  onSaveEmail(group.supplier);
                }}
              >
                Uložiť
              </button>
              <button type="button" className="btn sm ghost" disabled={emailBusy} onClick={onCancelEditEmail}>
                Zrušiť
              </button>
              {emailError !== "" && <p role="alert">{emailError}</p>}
            </>
          ) : (
            <>
              <span className="tosup-email">E-mail dodávateľa: {group.email ?? "nenastavený"}</span>
              {canChangeState && (
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => {
                    onStartEditEmail(group);
                  }}
                >
                  Upraviť e-mail
                </button>
              )}
            </>
          )}
        </div>
        {canChangeState && (
          <div className="tosup-actions">
            {/* issue 60: hromadné označenie/zrušenie CELEJ skupiny naraz —
                jedno tlačidlo, ktoré prepína smer podľa toho, či je skupina
                UŽ celá odškrtnutá (rovnaký zámer ako stará appka's
                `markGroupOrdered`/`allOrdered`). Review of PR 76, finding 5:
                mirror smeru fixu 6 (review of PR 75, finding 6) — tlačidlo
                musí byť needitovateľné AJ kým beží per-riadkový zápis pre
                NIEKTORÝ riadok TEJTO skupiny (`busyOrderedLineId`), nielen
                počas vlastného hromadného zápisu (`busyOrderedSupplier`). */}
            <button
              type="button"
              className="btn sm ghost"
              disabled={
                busyOrderedSupplier === group.supplier ||
                (busyOrderedLineId !== null && group.lines.some((l) => l.lineId === busyOrderedLineId)) ||
                floorBusyInGroup
              }
              onClick={() => {
                // issue 480: hromadné označenie zahŕňa objednávkové AJ predajňové
                // riadky (server `setSupplierLinesOrdered` nastaví oboje) — smer
                // podľa `allOrdered` (všetko objednané → zruší, inak označí).
                onToggleGroupOrdered(group.supplier, !allOrdered);
              }}
            >
              {allOrdered ? "↺ Zrušiť označenie skupiny" : "✔ Označiť skupinu ako objednané"}
            </button>
            {/* issue 118: majiteľ, doslovne "zatial skry este to nebudeme
                pouzivat" — SKRYTÉ (nie zmazané), `orderScreenFlags.ts`'s
                `SHOW_ORDER_MAIL_ACTIONS` je JEDNO miesto na vrátenie oboch
                tlačidiel + sprievodného textu nižšie naraz. */}
            {SHOW_ORDER_MAIL_ACTIONS && (
              <>
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => {
                    onCopyOrderToClipboard(group.supplier);
                  }}
                >
                  📋 Kopírovať objednávku
                </button>
                <button
                  type="button"
                  className="btn sm good"
                  disabled={group.email === null || !group.lines.some((l) => l.state === outstandingState)}
                  title={
                    group.email === null ? "Pre odoslanie mailom treba najprv nastaviť e-mail dodávateľa." : undefined
                  }
                  onClick={() => {
                    onOpenPreview(group.supplier);
                  }}
                >
                  ✉️ Poslať objednávku e-mailom
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {SHOW_ORDER_MAIL_ACTIONS && canChangeState && group.email === null && (
        <p className="reenote">Pre odoslanie mailom treba najprv nastaviť e-mail dodávateľa.</p>
      )}
      {sendResult?.supplier === group.supplier && <p role="status">{sendResult.message}</p>}
      {previewSupplier === group.supplier && (
        <div className="mail-preview" data-testid={`mail-preview-${group.supplier}`}>
          {previewError !== "" && <p role="alert">{previewError}</p>}
          {preview !== null && (
            <>
              <p>Komu: {preview.to ?? "—"}</p>
              <p>Predmet: {preview.subject}</p>
              <pre>{preview.body}</pre>
              <button
                type="button"
                className="btn sm good"
                disabled={sendBusy}
                onClick={() => {
                  onConfirmSend(group.supplier);
                }}
              >
                Odoslať
              </button>
              <button type="button" className="btn sm ghost" disabled={sendBusy} onClick={onClosePreview}>
                Zrušiť
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
