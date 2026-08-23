import { useContext, useState, type JSX } from "react";
import type { Me } from "../api.js";
import { fetchRiesitOrders, OrdersUnauthorizedError, setOrderLinesRiesitByCode } from "../ordersApi.js";
import { RiesitBadgeRefreshContext } from "../riesitBadgeContext.js";
import { useOrderLinesBoard } from "../useOrderLinesBoard.js";
import { OrderWriteFailuresBanner } from "./OrderWriteFailuresBanner.js";
import { SupplierOrderGroup } from "./SupplierOrderGroup.js";

// issue 450: šéfov kolega Štěpán (Discord 19.8.2026) — pôvodne placeholder.
// issue 476 (Štěpán, Discord 23.8.2026): funkcia doplnená — sekcia „Riešiť"
// zobrazuje riadky objednávok v stave `riesit` (piaty exkluzívny stav,
// princíp `nedostupne`), KOMPLETNE rovnaké ako „Na objednanie" (všetky funkcie
// riadku + zoskupenie po dodávateľoch). Jadro (dáta + mutácie + pomocné hooky)
// je ZDIEĽANÉ s OrdersSection cez `useOrderLinesBoard` — tu sa líši len zdroj
// riadkov (`/api/orders/riesit`), odstránenie riadku po zmene stavu na iný
// (`keepOnlyState: "riesit"`) a rýchle pole na číslo objednávky.
//
// VIDITEĽNÁ záložka (`nav.ts`, priečinok „eshop"), takže NEMÁ vlastný
// `<h1>`/`<h2>` — titulok „Riešiť" renderuje `App.tsx` cez `Topbar`
// (`.claude/rules/frontend-design.md`, rovnaký vzor ako OrdersSection).

// Rovnaké dve role ako server pre zmenu stavu (`requireRole("admin",
// "manazer")`) — skrýva rýchle pole aj stavové tlačidlá pre role, ktoré by
// aj tak dostali 403 (server ostáva skutočnou bránou).
const CAN_CHANGE_STATE_ROLES: ReadonlySet<Me["role"]> = new Set(["admin", "manazer"]);

export function RiesitSection({
  role,
  onSessionExpired,
}: {
  readonly role: Me["role"];
  readonly onSessionExpired: () => void;
}): JSX.Element {
  const canChangeState = CAN_CHANGE_STATE_ROLES.has(role);

  // issue 476: zmena stavu / rýchle pole tu menia počet riesit riadkov →
  // refetchni menu odznak (rovnako ako OrdersSection).
  const { refresh: refreshRiesitBadge } = useContext(RiesitBadgeRefreshContext);

  const board = useOrderLinesBoard({
    fetchLines: fetchRiesitOrders,
    onSessionExpired,
    canChangeState,
    keepOnlyState: "riesit",
    onStateChanged: refreshRiesitBadge,
    loadErrorMessage: "Objednávky na riešenie sa nepodarilo načítať.",
  });

  // Rýchle pole: číslo objednávky + Enter → stav `riesit` na všetkých jej
  // riadkoch. Vlastný lokálny stav (nie súčasť zdieľaného boardu — je to
  // funkcia len tejto obrazovky).
  const [code, setCode] = useState("");
  const [quickAddBusy, setQuickAddBusy] = useState(false);
  const [quickAddError, setQuickAddError] = useState("");
  const [quickAddMessage, setQuickAddMessage] = useState("");

  const submitQuickAdd = (): void => {
    const trimmed = code.trim();
    if (trimmed === "" || quickAddBusy) return;
    setQuickAddBusy(true);
    setQuickAddError("");
    setQuickAddMessage("");
    setOrderLinesRiesitByCode(trimmed)
      .then((res) => {
        setCode("");
        setQuickAddMessage(
          res.lineCount === 0
            ? `Objednávka „${trimmed}" už bola celá v Riešiť.`
            : `Objednávka „${trimmed}" pridaná do Riešiť.`,
        );
        // Refetch zoznamu (nové riadky sa zobrazia) + refresh menu odznaku.
        board.load();
        refreshRiesitBadge();
      })
      .catch((err: unknown) => {
        if (err instanceof OrdersUnauthorizedError) {
          onSessionExpired();
          return;
        }
        setQuickAddError(err instanceof Error ? err.message : "Označenie objednávky sa nepodarilo.");
      })
      .finally(() => {
        setQuickAddBusy(false);
      });
  };

  const totalLines = board.suppliers.reduce((sum, group) => sum + group.lines.length, 0);

  return (
    <section className="orders-section" data-testid="riesit-section">
      {canChangeState && (
        <form
          className="riesit-quick-add"
          data-testid="riesit-quick-add-form"
          onSubmit={(e) => {
            e.preventDefault();
            submitQuickAdd();
          }}
        >
          <label htmlFor="riesit-code-input">Pridať objednávku do Riešiť podľa čísla:</label>
          <input
            id="riesit-code-input"
            type="text"
            className="riesit-quick-add-input"
            data-testid="riesit-quick-add-input"
            placeholder="číslo objednávky…"
            value={code}
            disabled={quickAddBusy}
            onChange={(e) => {
              setCode(e.target.value);
            }}
          />
          <button
            type="submit"
            className="btn good"
            data-testid="riesit-quick-add-submit"
            disabled={quickAddBusy || code.trim() === ""}
          >
            Pridať
          </button>
        </form>
      )}
      {quickAddError !== "" && (
        <p role="alert" className="empty" data-testid="riesit-quick-add-error">
          {quickAddError}
        </p>
      )}
      {quickAddMessage !== "" && (
        <p role="status" data-testid="riesit-quick-add-message">
          {quickAddMessage}
        </p>
      )}

      {!board.loaded && <p>Načítavam…</p>}
      {board.error !== "" && <p role="alert">{board.error}</p>}
      <OrderWriteFailuresBanner
        failures={board.writeFailures}
        onDismiss={() => {
          board.setWriteFailures([]);
        }}
      />
      {board.loaded && totalLines === 0 && (
        <p className="empty" data-testid="riesit-empty">
          Zatiaľ tu nie sú žiadne položky na riešenie. Označ riadok tlačidlom „Riešiť" v „Na objednanie",
          alebo zadaj číslo objednávky vyššie.
        </p>
      )}
      {board.suppliers.map((group) => (
        <SupplierOrderGroup
          key={group.supplier}
          group={group}
          selectedSupplier={null}
          // V sekcii Riešiť sa NEskrývajú „vybavené" riadky — `isLineResolved`
          // by pri stave `riesit` (!== objednane) skryl VŠETKY riadky. Vždy
          // `false`, aby bol každý riesit riadok vidno.
          hideResolved={false}
          dirtyEditorLineIds={board.dirtyEditorLineIds}
          onEditorActivityChange={board.onEditorActivityChange}
          supplierDrafts={board.supplierDrafts}
          canChangeState={canChangeState}
          busyLineId={board.busyLineId}
          busyOrderedLineId={board.busyOrderedLineId}
          busyOrderedSupplier={board.busyOrderedSupplier}
          busySupplierLineId={board.busySupplierLineId}
          busySupplierLinkLineId={board.busySupplierLinkLineId}
          busyCommentOrderId={board.busyCommentOrderId}
          onChangeState={board.changeState}
          onChangeOrdered={board.changeOrdered}
          onAssignSupplier={board.assignSupplier}
          onSetSupplierLink={board.setSupplierLink}
          onChangeComment={board.changeComment}
          editingEmailSupplier={board.email.editingEmailSupplier}
          emailDraft={board.email.emailDraft}
          emailBusy={board.email.emailBusy}
          emailError={board.email.emailError}
          onEmailDraftChange={board.email.onEmailDraftChange}
          onStartEditEmail={board.email.onStartEditEmail}
          onSaveEmail={board.email.onSaveEmail}
          onCancelEditEmail={board.email.onCancelEditEmail}
          onToggleGroupOrdered={board.toggleGroupOrdered}
          onCopyOrderToClipboard={board.mail.copyOrderToClipboard}
          previewSupplier={board.mail.previewSupplier}
          preview={board.mail.preview}
          previewError={board.mail.previewError}
          sendBusy={board.mail.sendBusy}
          sendResult={board.mail.sendResult}
          onOpenPreview={board.mail.openPreview}
          onClosePreview={board.mail.closePreview}
          onConfirmSend={board.mail.confirmSend}
        />
      ))}
    </section>
  );
}
